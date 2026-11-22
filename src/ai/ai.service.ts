import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ApiError,
  BlockedReason,
  FinishReason,
  GenerateContentResponse,
  GoogleGenAI,
} from "@google/genai";
import {
  AI_MAX_OUTPUT_TOKENS,
  AI_MAX_SOURCE_CHARS,
  AI_MIN_SOURCE_CHARS,
  AI_PDF_MAX_BYTES,
  GEMINI_CLIENT,
  DEFAULT_AI_MODEL,
  DEFAULT_GENERATED_TYPES,
  GeneratableQuestionType,
} from "./ai.constants";
import { GenerateQuizDto } from "./dto/generate-quiz.dto";
import { AiQuotaService, AiQuotaStatus } from "./ai-quota.service";
import {
  PDF_MIME_TYPES,
  PdfTextExtractor,
  UnreadablePdfError,
  hasPdfSignature,
} from "./pdf-text";
import { SYSTEM_PROMPT, buildOutputSchema, buildUserPrompt } from "./ai.prompt";
import {
  MalformedAiOutputError,
  parseAndValidateQuestions,
} from "./generated-questions";
import { CreateQuestionDto } from "../quiz/dto/quiz.dto";

/** Fichier reçu par multer (champ `file`), réduit aux champs utilisés. */
export interface UploadedPdf {
  originalname?: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Réponse de `POST /api/quizzes/generate` : un brouillon, rien n'est enregistré. */
export interface GenerateQuizResponse {
  /** Questions valides, au format de `POST /api/quizzes/:id/questions`. */
  questions: CreateQuestionDto[];
  /** Nombre de questions demandé. */
  requested: number;
  /** Nombre de questions renvoyées par le modèle (avant filtrage). */
  generated: number;
  /** Questions écartées (invalides, type non demandé, doublons, surplus). */
  rejected: number;
  source: {
    type: "text" | "pdf";
    /** Longueur du texte du cours (après extraction et normalisation). */
    chars: number;
    /** Longueur réellement envoyée au modèle (≤ 60 000). */
    used_chars: number;
    /** Vrai si le texte a été tronqué à 60 000 caractères. */
    truncated: boolean;
  };
  /** Modèle utilisé (AI_MODEL). */
  model: string;
  /** État du quota après cette génération. */
  quota: AiQuotaStatus;
}

/**
 * Fins de génération qui signifient un blocage par les filtres de sécurité
 * (ou de politique d'usage) : la réponse n'est pas renvoyée.
 */
const SAFETY_FINISH_REASONS: ReadonlySet<string> = new Set([
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
  FinishReason.IMAGE_PROHIBITED_CONTENT,
]);

/**
 * Le fournisseur a bloqué la demande ou la réponse (filtres de sécurité :
 * `promptFeedback.blockReason` ou `finishReason` de sécurité).
 */
export class AiRefusalError extends Error {}

/** Message d'erreur de l'API indiquant une clé invalide (400 API_KEY_INVALID). */
const INVALID_KEY_PATTERN =
  /API_KEY_INVALID|API key not valid|API key expired/i;

/** Délai d'attente dépassé : abandon de la requête par le SDK (AbortSignal). */
function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Normalise les blancs (texte de PDF : césures de lignes, espaces multiples). */
export function normalizeSourceText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Génération d'un brouillon de quiz par IA (issue #11) depuis un texte ou un
 * PDF de cours. Seul le contenu pédagogique fourni par l'enseignant est
 * envoyé au fournisseur (aucune donnée élève). Rien n'est enregistré, à part
 * la ligne de quota.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @Optional()
    @Inject(GEMINI_CLIENT)
    private readonly client: GoogleGenAI | null,
    private readonly quota: AiQuotaService,
    private readonly pdf: PdfTextExtractor,
    private readonly config: ConfigService,
  ) {}

  get model(): string {
    return this.config.get<string>("AI_MODEL")?.trim() || DEFAULT_AI_MODEL;
  }

  getQuota(userId: string): Promise<AiQuotaStatus> {
    return this.quota.getStatus(userId);
  }

  async generate(
    userId: string,
    dto: GenerateQuizDto,
    file?: UploadedPdf,
  ): Promise<GenerateQuizResponse> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        "La génération par IA n'est pas configurée sur ce serveur (GEMINI_API_KEY absente).",
      );
    }

    const hasText = typeof dto.text === "string" && dto.text.trim() !== "";
    if (hasText && file) {
      throw new BadRequestException(
        "Fournissez soit un texte (text), soit un PDF (file), pas les deux.",
      );
    }
    if (!hasText && !file) {
      throw new BadRequestException(
        "Fournissez le cours : un texte (text) ou un PDF (file).",
      );
    }

    // Contrôle préalable : inutile d'extraire un PDF si le quota est atteint.
    await this.quota.assertAvailable(userId);

    const rawSource = file ? await this.extractPdf(file) : dto.text!;
    const source = normalizeSourceText(rawSource);
    if (source.length < AI_MIN_SOURCE_CHARS) {
      throw new UnprocessableEntityException(
        `Le contenu fourni est trop court pour générer des questions (${AI_MIN_SOURCE_CHARS} caractères au minimum).`,
      );
    }
    const truncated = source.length > AI_MAX_SOURCE_CHARS;
    const used = truncated ? source.slice(0, AI_MAX_SOURCE_CHARS) : source;
    const types: GeneratableQuestionType[] = dto.types?.length
      ? [...new Set(dto.types)]
      : DEFAULT_GENERATED_TYPES;

    const reservation = await this.quota.reserve(userId);
    try {
      const output = await this.callModel(used, dto.level, dto.count, types);
      const result = await parseAndValidateQuestions(output, types, dto.count);
      if (result.questions.length === 0) {
        this.logger.warn(
          `Génération IA sans question valide (${result.generated} renvoyées, toutes écartées)`,
        );
        throw new BadGatewayException(
          "L'IA n'a produit aucune question valide. Réessayez (aucun quota consommé).",
        );
      }
      if (result.rejected > 0) {
        this.logger.log(
          `Génération IA : ${result.rejected} question(s) écartée(s) sur ${result.generated}`,
        );
      }
      await this.quota.confirm(reservation.id, result.questions.length);
      return {
        questions: result.questions,
        requested: dto.count,
        generated: result.generated,
        rejected: result.rejected,
        source: {
          type: file ? "pdf" : "text",
          chars: source.length,
          used_chars: used.length,
          truncated,
        },
        model: this.model,
        quota: reservation.status,
      };
    } catch (error) {
      await this.quota.release(reservation.id);
      throw this.toHttpError(error);
    }
  }

  /** Contrôles du PDF (type MIME, signature, taille) puis extraction du texte. */
  private async extractPdf(file: UploadedPdf): Promise<string> {
    if (!(PDF_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        "Le fichier doit être un PDF (application/pdf).",
      );
    }
    if (!hasPdfSignature(file.buffer)) {
      throw new UnsupportedMediaTypeException(
        "Le fichier n'est pas un PDF valide (signature %PDF absente).",
      );
    }
    if (file.size > AI_PDF_MAX_BYTES || file.buffer.length > AI_PDF_MAX_BYTES) {
      // Normalement bloqué avant par multer (413).
      throw new HttpException("Le PDF dépasse 10 Mo.", 413);
    }
    let text: string;
    try {
      text = await this.pdf.extract(file.buffer);
    } catch (error) {
      if (error instanceof UnreadablePdfError) {
        throw new UnprocessableEntityException(
          "Ce PDF est illisible (fichier corrompu ou protégé par mot de passe).",
        );
      }
      throw error;
    }
    if (normalizeSourceText(text ?? "").length === 0) {
      throw new UnprocessableEntityException(
        "Ce PDF ne contient pas de texte extractible (document scanné ou composé d'images). Copiez le texte du cours dans le champ texte.",
      );
    }
    return text;
  }

  /** Appel au modèle, sortie structurée JSON. Renvoie le texte JSON brut. */
  private async callModel(
    source: string,
    level: string,
    count: number,
    types: GeneratableQuestionType[],
  ): Promise<string> {
    const response = await this.client!.models.generateContent({
      model: this.model,
      contents: buildUserPrompt({ source, level, count, types }),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
        // responseJsonSchema seul (jamais avec responseSchema).
        responseJsonSchema: buildOutputSchema(types),
      },
    });
    return this.extractText(response);
  }

  /**
   * Texte JSON de la réponse : parties texte du premier candidat, hors
   * réflexion du modèle. Lève AiRefusalError si la demande ou la réponse a
   * été bloquée par les filtres de sécurité.
   */
  private extractText(response: GenerateContentResponse): string {
    const blockReason = response.promptFeedback?.blockReason;
    if (
      blockReason &&
      blockReason !== BlockedReason.BLOCKED_REASON_UNSPECIFIED
    ) {
      this.logger.warn(
        `Demande IA bloquée par le fournisseur (${blockReason})`,
      );
      throw new AiRefusalError(String(blockReason));
    }
    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason && SAFETY_FINISH_REASONS.has(finishReason)) {
      this.logger.warn(
        `Réponse IA bloquée par le fournisseur (${finishReason})`,
      );
      throw new AiRefusalError(String(finishReason));
    }
    if (finishReason === FinishReason.MAX_TOKENS) {
      this.logger.warn("Sortie IA tronquée (maxOutputTokens atteint)");
    }
    return (candidate?.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }

  /** Traduit une erreur de génération en réponse HTTP propre. */
  private toHttpError(error: unknown): HttpException {
    if (error instanceof HttpException) return error;
    if (error instanceof MalformedAiOutputError) {
      this.logger.warn(`Sortie IA illisible : ${error.message}`);
      return new BadGatewayException(
        "La réponse de l'IA est illisible. Réessayez (aucun quota consommé).",
      );
    }
    if (error instanceof AiRefusalError) {
      return new UnprocessableEntityException(
        "L'IA a refusé de traiter ce document. Vérifiez son contenu (aucun quota consommé).",
      );
    }
    if (
      isTimeoutError(error) ||
      (error instanceof ApiError && error.status === 504)
    ) {
      this.logger.warn("Délai d'attente dépassé lors de l'appel IA");
      return new GatewayTimeoutException(
        "L'IA n'a pas répondu à temps. Réessayez avec un document plus court ou moins de questions (aucun quota consommé).",
      );
    }
    if (error instanceof ApiError) {
      return this.providerErrorToHttp(error);
    }
    if (error instanceof TypeError) {
      // fetch : coupure réseau, DNS, etc.
      this.logger.warn(`Fournisseur IA injoignable : ${error.message}`);
      return new ServiceUnavailableException(
        "Le service d'IA est momentanément indisponible. Réessayez dans quelques minutes (aucun quota consommé).",
      );
    }
    this.logger.error(
      `Erreur inattendue lors de la génération IA : ${(error as Error)?.message}`,
    );
    return new BadGatewayException(
      "La génération par IA a échoué. Réessayez (aucun quota consommé).",
    );
  }

  /**
   * Erreur HTTP renvoyée par l'API Gemini. Seul le statut est journalisé (le
   * message de l'API ne contient pas la clé, mais on reste prudent).
   */
  private providerErrorToHttp(error: ApiError): HttpException {
    const status = error.status;
    const message = error.message ?? "";
    if (status === 429) {
      // Limite de débit du fournisseur (RESOURCE_EXHAUSTED), distincte du
      // quota utilisateur (notre 429).
      this.logger.warn("Limite de débit du fournisseur IA atteinte (429)");
      return new ServiceUnavailableException(
        "Le service d'IA est momentanément saturé, réessayez dans quelques minutes (aucun quota consommé).",
      );
    }
    if (
      status === 401 ||
      status === 403 ||
      (status === 400 &&
        (INVALID_KEY_PATTERN.test(message) ||
          message.includes("FAILED_PRECONDITION")))
    ) {
      this.logger.error(
        `Appel IA refusé par le fournisseur (statut ${status}) : vérifier GEMINI_API_KEY et le projet Google`,
      );
      return new ServiceUnavailableException(
        "La génération par IA est mal configurée sur ce serveur.",
      );
    }
    if (status >= 500) {
      this.logger.warn(`Fournisseur IA indisponible (statut ${status})`);
      return new ServiceUnavailableException(
        "Le service d'IA est momentanément indisponible. Réessayez dans quelques minutes (aucun quota consommé).",
      );
    }
    this.logger.error(`Erreur du fournisseur IA (statut ${status})`);
    return new BadGatewayException(
      "La génération par IA a échoué. Réessayez (aucun quota consommé).",
    );
  }
}
