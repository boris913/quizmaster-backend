import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  Logger,
} from "@nestjs/common";
import { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_CLIENT } from "../database/database.module";
import {
  CreateQuizDto,
  UpdateQuizDto,
  CreateQuestionDto,
  ImportQuestionsDto,
  ImportQueryDto,
  ImageUploadUrlDto,
  IMAGE_URL_MAX_LENGTH,
  QUESTION_IMAGE_CONTENT_TYPES,
  QUESTION_IMAGE_MAX_BYTES,
} from "./dto/quiz.dto";
import { randomBytes, randomUUID } from "crypto";
import {
  DEFAULT_TRUE_FALSE_OPTIONS,
  QUESTION_TYPES,
  QuestionType,
  normalizeShortAnswer,
  scrambleOrderingIds,
  validateQuestionByType,
} from "../common/utils/question-types.util";
import { toCsv } from "../session/results/results-csv";
import { validateQuestionPlain } from "./question-validation";
import { decodeTextFile, parseCsv } from "./importers/csv.parser";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
  ImportFileError,
  ImportFormat,
  ImportRowError,
  ParsedImport,
} from "./importers/import.types";
import { parseKahootRows } from "./importers/kahoot.importer";
import {
  TEMPLATE_EXAMPLES,
  TEMPLATE_HEADERS,
  parseTabularRows,
} from "./importers/tabular.importer";
import { readXlsxRows } from "./importers/xlsx.reader";

/** Bucket Supabase Storage des images de question (issue #7). */
export const QUESTION_IMAGES_BUCKET = "question-images";

/** Extension de fichier par type MIME accepté. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Jeton de partage : 24 octets aléatoires → 32 caractères base64url. */
export const SHARE_TOKEN_BYTES = 24;
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** Chemin d'une image dans le bucket : `<quizId>/<uuid>.<ext>`. */
const BUCKET_IMAGE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp|gif)$/i;

/** Extensions de fichier acceptées par format d'import (si le nom en a une). */
const IMPORT_EXTENSIONS: Record<ImportFormat, string[]> = {
  markdown: ["md", "markdown", "txt"],
  csv: ["csv", "txt"],
  xlsx: ["xlsx"],
  kahoot: ["xlsx"],
};

/** Fichier reçu en multipart (sous-ensemble de `Express.Multer.File`). */
export interface UploadedImportFile {
  buffer: Buffer;
  size: number;
  originalname?: string;
  mimetype?: string;
}

/** Avertissement de copie (question non copiée ou image non copiée). */
export interface CopyWarning {
  question_number: number;
  message: string;
}

/** Durée de validité d'une URL signée d'upload Supabase (fixée par Supabase). */
export const SIGNED_UPLOAD_URL_TTL_SECONDS = 2 * 60 * 60;

/** Marqueurs d'en-tête de question : "[timer:30]", "[type: ordering]"... */
const HEADER_TAG = /\[\s*(timer|points|type)\s*:\s*([^\]]*?)\s*\]/gi;

/** Image de question dans l'import : "![texte alternatif](https://...)". */
const IMAGE_LINE = /^!\[[^\]]*\]\(\s*(\S+?)\s*\)$/;

/** URL d'image acceptée (DTO, import et contrainte SQL, migration 005). */
const IMAGE_URL = /^https?:\/\/\S+$/i;

/** Variante / réponse attendue dans l'import : "= Paris". */
const EXPECTED_LINE = /^=\s*(.+)$/;

/** Option : "A) Texte [correct]" (A à F). */
const OPTION_LINE = /^([A-F])\)\s+(.+?)$/;

/** Suffixe "[correct]" d'une option. */
const CORRECT_SUFFIX = /\s*\[correct\]\s*$/i;

/** Valeurs acceptées pour "= vrai" / "= faux" (true_false). */
const TRUE_VALUES = ["vrai", "true", "v", "oui"];
const FALSE_VALUES = ["faux", "false", "f", "non"];

/** Longueur maximale d'une explication (DTO et contrainte SQL, migration 003). */
export const EXPLANATION_MAX_LENGTH = 500;

/** Ligne d'explication de l'import Markdown : "> Explication : texte". */
const EXPLANATION_LINE = /^>\s*explication\s*:\s*(.*)$/i;

/** Chaîne vide ou absente → null (colonne `questions.explanation`). */
function normalizeExplanation(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

/**
 * Options et bonnes réponses telles qu'enregistrées, selon le type (la
 * question est supposée valide, voir `validateQuestionByType`) :
 * - true_false : options fixes `true`/`false` (textes fournis conservés,
 *   sinon « Vrai » / « Faux ») ;
 * - short_answer : `options: []`, variantes rognées et dédoublonnées après
 *   normalisation ;
 * - ordering : ids réattribués au hasard (`scrambleOrderingIds`) ;
 * - poll : `correct_answers: []`.
 */
function normalizeAnswersByType(q: CreateQuestionDto): {
  options: { id: string; text: string }[];
  correct_answers: string[];
} {
  const options = (q.options ?? []).map((o) => ({ id: o.id, text: o.text }));
  const correct = q.correct_answers ?? [];
  switch (q.type) {
    case "true_false":
      return {
        options: DEFAULT_TRUE_FALSE_OPTIONS.map((def) => ({
          id: def.id,
          text: options.find((o) => o.id === def.id)?.text ?? def.text,
        })),
        correct_answers: [...correct],
      };
    case "short_answer": {
      const seen = new Set<string>();
      const variants: string[] = [];
      for (const variant of correct) {
        const key = normalizeShortAnswer(variant);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        variants.push(variant.trim());
      }
      return { options: [], correct_answers: variants };
    }
    case "ordering":
      return scrambleOrderingIds(options, correct);
    case "poll":
      return { options, correct_answers: [] };
    default:
      return { options, correct_answers: [...correct] };
  }
}

@Injectable()
export class QuizService {
  private readonly logger = new Logger(QuizService.name);

  constructor(@Inject(SUPABASE_CLIENT) private supabase: SupabaseClient) {}

  // ============================================================
  // QUIZ CRUD
  // ============================================================

  async createQuiz(creatorId: string, dto: CreateQuizDto) {
    const { questions, ...quizData } = dto;

    const { data: quiz, error } = await this.supabase
      .from("quizzes")
      .insert({ ...quizData, creator_id: creatorId })
      .select()
      .single();

    if (error) throw new Error(`Erreur création quiz: ${error.message}`);

    // Insérer les questions si fournies
    if (questions && questions.length > 0) {
      await this.addQuestions(quiz.id, creatorId, questions);
    }

    return this.getQuizById(quiz.id, creatorId);
  }

  /**
   * Détail d'un quiz avec ses questions (bonnes réponses comprises), réservé à
   * son créateur. Renvoie 404 si le quiz n'existe pas OU appartient à un autre
   * utilisateur, pour ne pas révéler son existence.
   *
   * Pas d'usage interne : le gateway charge les questions d'une session en
   * cours directement depuis la table `questions`.
   */
  async getQuizById(quizId: string, requesterId: string) {
    const { data: quiz, error } = await this.supabase
      .from("quizzes")
      .select("*")
      .eq("id", quizId)
      .single();

    if (error || !quiz || !requesterId || quiz.creator_id !== requesterId) {
      throw new NotFoundException("Quiz introuvable");
    }

    // Récupérer les questions
    const { data: questions } = await this.supabase
      .from("questions")
      .select("*")
      .eq("quiz_id", quizId)
      .order("order_index", { ascending: true });

    return { ...quiz, questions: questions || [] };
  }

  async getMyQuizzes(creatorId: string) {
    const { data, error } = await this.supabase
      .from("quizzes")
      .select(
        "id, title, description, total_questions, created_at, updated_at, global_timer_seconds, use_global_timer",
      )
      .eq("creator_id", creatorId)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Erreur récupération quiz: ${error.message}`);
    return data || [];
  }

  async updateQuiz(quizId: string, creatorId: string, dto: UpdateQuizDto) {
    await this.assertOwnership(quizId, creatorId);

    const { data, error } = await this.supabase
      .from("quizzes")
      .update(dto)
      .eq("id", quizId)
      .select()
      .single();

    if (error) throw new Error(`Erreur mise à jour: ${error.message}`);
    return data;
  }

  async deleteQuiz(quizId: string, creatorId: string) {
    await this.assertOwnership(quizId, creatorId);

    const { error } = await this.supabase
      .from("quizzes")
      .delete()
      .eq("id", quizId);

    if (error) throw new Error(`Erreur suppression: ${error.message}`);
    return { message: "Quiz supprimé avec succès" };
  }

  // ============================================================
  // QUESTIONS
  // ============================================================

  async addQuestions(
    quizId: string,
    creatorId: string,
    questions: CreateQuestionDto[],
  ) {
    await this.assertOwnership(quizId, creatorId);
    return this.insertQuestions(quizId, questions);
  }

  /**
   * Insère des questions à la suite de celles du quiz (propriété déjà
   * vérifiée par l'appelant). Règles par type et URL d'image revérifiées.
   */
  private async insertQuestions(
    quizId: string,
    questions: CreateQuestionDto[],
  ) {
    // Récupérer l'index courant pour continuer la numérotation
    const { data: existing } = await this.supabase
      .from("questions")
      .select("order_index")
      .eq("quiz_id", quizId)
      .order("order_index", { ascending: false })
      .limit(1);

    const startIndex =
      existing && existing.length > 0 ? existing[0].order_index + 1 : 0;

    // Règles par type (issue #7) : aussi pour l'import Markdown, qui ne
    // passe pas par le ValidationPipe
    questions.forEach((q, i) => {
      const errors = validateQuestionByType(q);
      const imageUrl = normalizeExplanation(q.image_url);
      if (
        imageUrl &&
        (imageUrl.length > IMAGE_URL_MAX_LENGTH || !IMAGE_URL.test(imageUrl))
      ) {
        errors.push(
          `image_url doit être une URL http(s) de ${IMAGE_URL_MAX_LENGTH} caractères au plus`,
        );
      }
      if (errors.length > 0) {
        throw new BadRequestException(
          `Question ${i + 1} : ${errors.join(" ; ")}`,
        );
      }
    });

    const questionsToInsert = questions.map((q, index) => ({
      quiz_id: quizId,
      text: q.text,
      type: q.type,
      ...normalizeAnswersByType(q),
      max_points: q.max_points,
      timer_seconds: q.timer_seconds || 30,
      explanation: normalizeExplanation(q.explanation),
      image_url: normalizeExplanation(q.image_url),
      order_index: startIndex + index,
    }));

    const { data, error } = await this.supabase
      .from("questions")
      .insert(questionsToInsert)
      .select();

    if (error) throw new Error(`Erreur ajout questions: ${error.message}`);
    return data;
  }

  async deleteQuestion(quizId: string, questionId: string, creatorId: string) {
    await this.assertOwnership(quizId, creatorId);

    const { error } = await this.supabase
      .from("questions")
      .delete()
      .eq("id", questionId)
      .eq("quiz_id", quizId);

    if (error) throw new Error(`Erreur suppression question: ${error.message}`);
    return { message: "Question supprimée" };
  }

  async reorderQuestions(
    quizId: string,
    creatorId: string,
    orderedIds: string[],
  ) {
    await this.assertOwnership(quizId, creatorId);

    const updates = orderedIds.map((id, index) => ({
      id,
      order_index: index,
    }));

    for (const update of updates) {
      await this.supabase
        .from("questions")
        .update({ order_index: update.order_index })
        .eq("id", update.id)
        .eq("quiz_id", quizId);
    }

    return { message: "Questions réordonnées" };
  }

  // ============================================================
  // IMAGES DE QUESTION (issue #7)
  // ============================================================

  /**
   * URL signée d'upload d'une image de question dans le bucket
   * `question-images`, générée avec le client service (la clé ne quitte
   * jamais le serveur). Le chemin est imposé : `<quizId>/<uuid>.<ext>`.
   *
   * Le type MIME et la taille déclarés sont vérifiés ici (le DTO le fait
   * déjà, défense en profondeur) ; le bucket impose aussi
   * `allowed_mime_types` et `file_size_limit` (2 Mo) au fichier réellement
   * envoyé.
   */
  async createImageUploadUrl(
    quizId: string,
    creatorId: string,
    dto: ImageUploadUrlDto,
  ) {
    const contentType = dto?.content_type;
    if (
      !(QUESTION_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)
    ) {
      throw new BadRequestException(
        `Type d'image refusé (acceptés : ${QUESTION_IMAGE_CONTENT_TYPES.join(", ")})`,
      );
    }
    const size = dto?.size;
    if (
      !Number.isInteger(size) ||
      size < 1 ||
      size > QUESTION_IMAGE_MAX_BYTES
    ) {
      throw new BadRequestException("Taille d'image invalide (2 Mo au plus)");
    }

    await this.assertOwnership(quizId, creatorId);

    const path = `${quizId}/${randomUUID()}.${IMAGE_EXTENSIONS[contentType]}`;
    const bucket = this.supabase.storage.from(QUESTION_IMAGES_BUCKET);
    const { data, error } = await bucket.createSignedUploadUrl(path);
    if (error || !data) {
      throw new Error(
        `Erreur création URL d'upload: ${error?.message ?? "réponse vide"}`,
      );
    }
    const publicUrl = bucket.getPublicUrl(path).data.publicUrl;
    if (publicUrl.length > IMAGE_URL_MAX_LENGTH) {
      throw new Error("URL publique de l'image trop longue");
    }

    return {
      upload_url: data.signedUrl,
      token: data.token,
      path: data.path ?? path,
      bucket: QUESTION_IMAGES_BUCKET,
      public_url: publicUrl,
      content_type: contentType,
      max_bytes: QUESTION_IMAGE_MAX_BYTES,
      expires_in: SIGNED_UPLOAD_URL_TTL_SECONDS,
    };
  }

  // ============================================================
  // IMPORT DEPUIS FICHIER MARKDOWN
  // ============================================================

  async importFromMarkdown(
    quizId: string,
    creatorId: string,
    dto: ImportQuestionsDto,
  ) {
    await this.assertOwnership(quizId, creatorId);

    const questions = this.parseMarkdownQuestions(
      dto.questions_content,
      dto.answers_content,
    );

    if (questions.length === 0) {
      throw new BadRequestException("Aucune question trouvée dans le fichier");
    }

    return this.addQuestions(quizId, creatorId, questions);
  }

  /**
   * Parse le format Markdown d'import (voir README, « Import Markdown »).
   *
   * Question 1 [timer:30] [points:100] [type: ordering]
   * Énoncé de la question
   * ![texte alternatif](https://.../image.png)
   * A) Proposition A [correct]
   * B) Proposition B
   * = Variante acceptée   (short_answer ; "= vrai" / "= faux" pour true_false)
   * > Explication : texte facultatif (≤ 500 caractères), révélé à la clôture
   *
   * Marqueurs d'en-tête dans n'importe quel ordre. Sans `[type: ...]`, le
   * type est déduit comme avant : `multiple` si plusieurs `[correct]`, sinon
   * `single`, et la question est ignorée si elle a moins de 2 options. Pour
   * `ordering`, les options sont listées dans l'ordre attendu.
   */
  private parseMarkdownQuestions(
    questionsContent: string,
    answersContent?: string,
  ): CreateQuestionDto[] {
    const lines = questionsContent.split("\n").map((l) => l.trim());
    const questions: CreateQuestionDto[] = [];
    /** Type déclaré par `[type: ...]` pour chaque question (sinon null). */
    const explicitTypes: (QuestionType | null)[] = [];

    interface Draft {
      text?: string;
      timer_seconds: number;
      max_points: number;
      type: QuestionType | null;
      image_url: string | null;
      options: Array<{ id: string; text: string }>;
      correct: string[];
      expected: string[];
      explanation: string | null;
    }
    let draft: Draft | null = null;

    const saveCurrentQuestion = () => {
      if (!draft) return;
      const number = questions.length + 1;

      // Sans marqueur de type : comportement historique (question ignorée
      // si elle a moins de 2 options)
      if (!draft.type && draft.options.length < 2) return;
      if (!draft.text) {
        throw new BadRequestException(`Question ${number} : énoncé manquant`);
      }

      const type: QuestionType =
        draft.type ?? (draft.correct.length > 1 ? "multiple" : "single");
      let options = draft.options;
      let correct = draft.correct;
      if (type === "ordering") {
        correct = options.map((o) => o.id);
      } else if (type === "short_answer") {
        correct = draft.expected;
      } else if (type === "poll") {
        correct = [];
      } else if (type === "true_false") {
        options = [];
        const value = (draft.expected[0] ?? "").toLowerCase();
        correct = TRUE_VALUES.includes(value)
          ? ["true"]
          : FALSE_VALUES.includes(value)
            ? ["false"]
            : [];
      }

      const question: CreateQuestionDto = {
        text: draft.text,
        type,
        options,
        correct_answers: correct,
        max_points: draft.max_points,
        timer_seconds: draft.timer_seconds,
      };
      if (draft.image_url) question.image_url = draft.image_url;
      if (draft.explanation) {
        if (draft.explanation.length > EXPLANATION_MAX_LENGTH) {
          throw new BadRequestException(
            `Question ${number} : l'explication dépasse ${EXPLANATION_MAX_LENGTH} caractères`,
          );
        }
        question.explanation = draft.explanation;
      }
      questions.push(question);
      explicitTypes.push(draft.type);
    };

    for (const line of lines) {
      if (!line || line.startsWith("Quiz:")) continue;

      // Nouvelle question : "Question N [timer:X] [points:Y] [type:T]"
      if (/^Question\s+\d+\b/i.test(line)) {
        saveCurrentQuestion();
        draft = {
          timer_seconds: 30,
          max_points: 100,
          type: null,
          image_url: null,
          options: [],
          correct: [],
          expected: [],
          explanation: null,
        };
        for (const [, rawKey, rawValue] of line.matchAll(HEADER_TAG)) {
          const key = rawKey.toLowerCase();
          const value = rawValue.trim();
          if (key === "timer" && /^\d+$/.test(value)) {
            draft.timer_seconds = parseInt(value, 10);
          } else if (key === "points" && /^\d+$/.test(value)) {
            draft.max_points = parseInt(value, 10);
          } else if (key === "type") {
            const type = value.toLowerCase().replace(/[\s-]+/g, "_");
            if (!(QUESTION_TYPES as readonly string[]).includes(type)) {
              throw new BadRequestException(
                `Question ${questions.length + 1} : type inconnu "${value}" (attendus : ${QUESTION_TYPES.join(", ")})`,
              );
            }
            draft.type = type as QuestionType;
          }
        }
        continue;
      }

      if (!draft) continue;

      // Explication : "> Explication : texte" (n'importe où sous la question)
      const explanationMatch = line.match(EXPLANATION_LINE);
      if (explanationMatch) {
        draft.explanation = normalizeExplanation(explanationMatch[1]);
        continue;
      }

      // Image : "![texte alternatif](url)"
      const imageMatch = line.match(IMAGE_LINE);
      if (imageMatch) {
        draft.image_url = imageMatch[1];
        continue;
      }

      // Réponse attendue / variante acceptée : "= texte" (après l'énoncé)
      const expectedMatch = line.match(EXPECTED_LINE);
      if (expectedMatch && draft.text) {
        draft.expected.push(expectedMatch[1].trim());
        continue;
      }

      // Ligne de texte de question (après l'entête "Question N")
      if (!draft.text && !OPTION_LINE.test(line)) {
        draft.text = line;
        continue;
      }

      // Option : "A) Texte [correct]"
      const optionMatch = line.match(OPTION_LINE);
      if (optionMatch) {
        const optId = optionMatch[1];
        draft.options.push({
          id: optId,
          text: optionMatch[2].replace(CORRECT_SUFFIX, ""),
        });
        if (CORRECT_SUFFIX.test(optionMatch[2])) draft.correct.push(optId);
      }
    }

    // Sauvegarder la dernière question
    saveCurrentQuestion();

    // Si un fichier de réponses séparé est fourni, l'appliquer
    if (answersContent) {
      this.applyAnswersFile(questions, answersContent, explicitTypes);
    }

    return questions;
  }

  /**
   * Format reponses.md :
   * ## Question 1
   * C
   *
   * ## Question 2
   * A,B
   *
   * Ne s'applique qu'aux questions à choix : une question déclarée avec un
   * autre type que single/multiple (`[type: ...]`) garde les réponses du
   * fichier de questions.
   */
  private applyAnswersFile(
    questions: CreateQuestionDto[],
    answersContent: string,
    explicitTypes: (QuestionType | null)[] = [],
  ) {
    const sections = answersContent.split(/##\s+Question\s+/i).slice(1);

    sections.forEach((section, index) => {
      if (index >= questions.length) return;
      const explicit = explicitTypes[index] ?? null;
      if (explicit && explicit !== "single" && explicit !== "multiple") return;
      const lines = section
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 2) return;

      const answers = lines[1].split(",").map((a) => a.trim().toUpperCase());
      questions[index].correct_answers = answers;
      if (!explicit) {
        questions[index].type = answers.length > 1 ? "multiple" : "single";
      }
    });
  }

  // ============================================================
  // DUPLICATION ET PARTAGE (issue #12)
  // ============================================================

  /**
   * POST /api/quizzes/:id/duplicate : copie complète d'un quiz de
   * l'utilisateur (questions dans le même ordre, images copiées dans le
   * dossier du nouveau quiz). Titre suffixé de « (copie) ».
   */
  async duplicateQuiz(quizId: string, userId: string) {
    const { data: source } = await this.supabase
      .from("quizzes")
      .select("*")
      .eq("id", quizId)
      .single();
    if (!source || !userId || source.creator_id !== userId) {
      throw new NotFoundException("Quiz introuvable");
    }
    const suffix = " (copie)";
    const title = `${String(source.title).slice(0, 200 - suffix.length)}${suffix}`;
    return this.copyQuiz(source, userId, title);
  }

  /**
   * POST /api/quizzes/:id/share : crée ou régénère le jeton de partage
   * (l'ancien lien cesse aussitôt de fonctionner).
   */
  async createShareLink(quizId: string, userId: string) {
    await this.assertOwnership(quizId, userId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
      const { error } = await this.supabase
        .from("quizzes")
        .update({ share_token: token })
        .eq("id", quizId);
      if (!error) return { share_token: token };
      // 23505 : collision de jeton (improbable), on régénère
      if (error.code !== "23505") {
        throw new Error(`Erreur création du lien de partage: ${error.message}`);
      }
    }
    throw new Error("Erreur création du lien de partage: collisions répétées");
  }

  /** DELETE /api/quizzes/:id/share : révoque le lien de partage. */
  async revokeShareLink(quizId: string, userId: string) {
    await this.assertOwnership(quizId, userId);
    const { error } = await this.supabase
      .from("quizzes")
      .update({ share_token: null })
      .eq("id", quizId);
    if (error) {
      throw new Error(`Erreur révocation du lien de partage: ${error.message}`);
    }
    return { share_token: null };
  }

  /**
   * GET /api/quizzes/shared/:token (public) : aperçu d'un quiz partagé.
   * Ni bonnes réponses ni explications : ces colonnes ne sont même pas lues.
   * Jeton inconnu, révoqué ou mal formé → 404.
   */
  async getSharedQuiz(token: string) {
    const quiz = await this.findSharedQuiz(
      token,
      "id, title, description, global_timer_seconds, use_global_timer, created_at",
    );
    const { data: questions, error } = await this.supabase
      .from("questions")
      .select(
        "text, type, options, image_url, max_points, timer_seconds, order_index",
      )
      .eq("quiz_id", quiz.id)
      .order("order_index", { ascending: true });
    if (error) throw new Error(`Erreur aperçu du quiz: ${error.message}`);

    const list = (questions ?? []).map(
      (q: Record<string, unknown>, i: number) => ({
        position: i + 1,
        text: q.text,
        type: q.type,
        options: Array.isArray(q.options)
          ? (q.options as { id: string; text: string }[]).map((o) => ({
              id: o.id,
              text: o.text,
            }))
          : [],
        image_url: q.image_url ?? null,
        max_points: q.max_points,
        timer_seconds: q.timer_seconds,
      }),
    );
    return {
      title: quiz.title,
      description: quiz.description ?? null,
      global_timer_seconds: quiz.global_timer_seconds,
      use_global_timer: quiz.use_global_timer,
      created_at: quiz.created_at,
      question_count: list.length,
      questions: list,
    };
  }

  /**
   * POST /api/quizzes/shared/:token/copy : copie un quiz partagé dans le
   * compte de l'utilisateur connecté (copie indépendante de l'original).
   */
  async copySharedQuiz(token: string, userId: string) {
    const source = await this.findSharedQuiz(token, "*");
    return this.copyQuiz(source, userId, String(source.title));
  }

  private async findSharedQuiz(token: string, columns: string) {
    if (typeof token !== "string" || !SHARE_TOKEN_PATTERN.test(token)) {
      throw new NotFoundException("Lien de partage invalide ou révoqué");
    }
    const { data } = await this.supabase
      .from("quizzes")
      .select(columns)
      .eq("share_token", token)
      .maybeSingle();
    if (!data) {
      throw new NotFoundException("Lien de partage invalide ou révoqué");
    }
    return data as unknown as Record<string, any>;
  }

  /**
   * Copie un quiz (ligne `quizzes` complète) pour `ownerId` :
   * - chaque question repasse par la validation de `CreateQuestionDto` (une
   *   question invalide n'est pas copiée et est signalée) ;
   * - les ids d'une question `ordering` sont réattribués comme à toute
   *   création, avec `correct_answers` traduit (question jouable) ;
   * - les images du bucket sont copiées dans `<nouveauQuiz>/<uuid>.<ext>` ;
   *   si la copie échoue, la question est gardée sans image et signalée ;
   *   une image externe (hors bucket) garde son URL.
   */
  private async copyQuiz(
    source: Record<string, any>,
    ownerId: string,
    title: string,
  ): Promise<{ quiz: Record<string, unknown>; warnings: CopyWarning[] }> {
    const { data: rows, error: questionsError } = await this.supabase
      .from("questions")
      .select("*")
      .eq("quiz_id", source.id)
      .order("order_index", { ascending: true });
    if (questionsError) {
      throw new Error(
        `Erreur lecture des questions: ${questionsError.message}`,
      );
    }

    const warnings: CopyWarning[] = [];
    const prepared: { number: number; question: CreateQuestionDto }[] = [];
    for (const [index, row] of (rows ?? []).entries()) {
      const plain: Record<string, unknown> = {
        text: row.text,
        type: row.type,
        options: Array.isArray(row.options)
          ? row.options.map((o: { id: string; text: string }) => ({
              id: o.id,
              text: o.text,
            }))
          : [],
        correct_answers: Array.isArray(row.correct_answers)
          ? [...row.correct_answers]
          : [],
        max_points: row.max_points,
        timer_seconds: row.timer_seconds,
      };
      if (row.explanation) plain.explanation = row.explanation;
      if (row.image_url) plain.image_url = row.image_url;
      const result = await validateQuestionPlain(plain);
      if (result.ok === false) {
        warnings.push({
          question_number: index + 1,
          message: `question non copiée : ${result.errors.join(" ; ")}`,
        });
        continue;
      }
      prepared.push({ number: index + 1, question: result.question });
    }

    const { data: quiz, error } = await this.supabase
      .from("quizzes")
      .insert({
        creator_id: ownerId,
        title,
        description: source.description ?? null,
        global_timer_seconds: source.global_timer_seconds,
        use_global_timer: source.use_global_timer,
        source_quiz_id: source.id,
      })
      .select()
      .single();
    if (error || !quiz) {
      throw new Error(
        `Erreur copie du quiz: ${error?.message ?? "réponse vide"}`,
      );
    }

    const copiedPaths: string[] = [];
    for (const item of prepared) {
      const url = item.question.image_url;
      if (!url) continue;
      const copy = await this.copyQuestionImage(url, quiz.id);
      if (copy.kind === "copied") {
        item.question.image_url = copy.url;
        copiedPaths.push(copy.path);
      } else if (copy.kind === "failed") {
        delete item.question.image_url;
        warnings.push({
          question_number: item.number,
          message: `image non copiée (${copy.reason}) : question copiée sans image`,
        });
      }
    }

    if (prepared.length > 0) {
      try {
        await this.insertQuestions(
          quiz.id,
          prepared.map((p) => p.question),
        );
      } catch (e) {
        // Pas de quiz à moitié copié : on retire le quiz et les images
        await this.supabase.from("quizzes").delete().eq("id", quiz.id);
        if (copiedPaths.length > 0) {
          try {
            await this.supabase.storage
              .from(QUESTION_IMAGES_BUCKET)
              .remove(copiedPaths);
          } catch {
            // Nettoyage best effort : des fichiers orphelins sans lien
          }
        }
        throw e;
      }
    }

    return { quiz: await this.getQuizById(quiz.id, ownerId), warnings };
  }

  /**
   * Copie côté serveur (client service) d'une image du bucket vers le
   * dossier du quiz `targetQuizId`. `external` : URL hors bucket, rien à
   * copier.
   */
  private async copyQuestionImage(
    url: string,
    targetQuizId: string,
  ): Promise<
    | { kind: "external" }
    | { kind: "copied"; url: string; path: string }
    | { kind: "failed"; reason: string }
  > {
    try {
      const bucket = this.supabase.storage.from(QUESTION_IMAGES_BUCKET);
      const probe = bucket.getPublicUrl("x").data.publicUrl;
      const prefix = probe.slice(0, -1);
      const bare = url.split(/[?#]/)[0];
      if (!bare.startsWith(prefix)) return { kind: "external" };
      const path = decodeURIComponent(bare.slice(prefix.length));
      if (!BUCKET_IMAGE_PATH.test(path)) {
        return { kind: "failed", reason: "chemin d'image inattendu" };
      }
      const ext = path.split(".").pop()!.toLowerCase();
      const target = `${targetQuizId}/${randomUUID()}.${ext}`;
      const { error } = await bucket.copy(path, target);
      if (error) {
        this.logger.warn(`Copie d'image ${path} échouée : ${error.message}`);
        return { kind: "failed", reason: "copie refusée par le stockage" };
      }
      return {
        kind: "copied",
        url: bucket.getPublicUrl(target).data.publicUrl,
        path: target,
      };
    } catch (e) {
      this.logger.warn(`Copie d'image échouée : ${(e as Error).message}`);
      return { kind: "failed", reason: "erreur du stockage" };
    }
  }

  // ============================================================
  // IMPORT CSV / XLSX / KAHOOT (issue #12)
  // ============================================================

  /** GET /api/quizzes/import-template.csv : modèle d'import (`;`, UTF-8 + BOM). */
  getImportTemplateCsv(): string {
    return toCsv([[...TEMPLATE_HEADERS], ...TEMPLATE_EXAMPLES]);
  }

  /**
   * POST /api/quizzes/:id/import. Sans `format` : import Markdown historique
   * (corps JSON, réponse = questions créées). Avec `format` : analyse du
   * fichier, validation de chaque question comme
   * `POST /api/quizzes/:id/questions`, puis (hors `dryRun`) insertion des
   * questions valides ; les lignes invalides sont listées dans `errors`.
   */
  async importQuestions(
    quizId: string,
    userId: string,
    query: ImportQueryDto,
    body: ImportQuestionsDto | undefined,
    file?: UploadedImportFile,
  ) {
    if (!query?.format) {
      if (file) {
        throw new BadRequestException(
          "Paramètre format requis pour importer un fichier (markdown, csv, xlsx, kahoot)",
        );
      }
      if (typeof body?.questions_content !== "string") {
        throw new BadRequestException("questions_content requis");
      }
      return this.importFromMarkdown(quizId, userId, body);
    }

    await this.assertOwnership(quizId, userId);
    const format = query.format;
    const dryRun = query.dryRun === true;

    let parsed: ParsedImport;
    try {
      parsed = await this.parseImportFile(format, body, file);
    } catch (e) {
      if (e instanceof ImportFileError) {
        if (e.kind === "too_large") {
          throw new PayloadTooLargeException(e.message);
        }
        if (e.kind === "unsupported_type") {
          throw new UnsupportedMediaTypeException(e.message);
        }
        throw new BadRequestException(e.message);
      }
      throw e;
    }

    const errors: ImportRowError[] = [...parsed.errors];
    const valid: { row: number; question: CreateQuestionDto }[] = [];
    for (const candidate of parsed.candidates) {
      const result = await validateQuestionPlain(candidate.question);
      if (result.ok === false) {
        errors.push({
          row: candidate.row,
          message: result.errors.join(" ; "),
        });
      } else {
        valid.push({ row: candidate.row, question: result.question });
      }
    }
    errors.sort((a, b) => a.row - b.row);

    let imported = 0;
    if (!dryRun && valid.length > 0) {
      const inserted = await this.insertQuestions(
        quizId,
        valid.map((v) => v.question),
      );
      imported = inserted?.length ?? valid.length;
    }

    return {
      format,
      dry_run: dryRun,
      total_rows: parsed.candidates.length + parsed.errors.length,
      valid: valid.length,
      imported,
      questions: valid.map((v) => ({ row: v.row, ...v.question })),
      errors,
    };
  }

  /** Lit et met en forme le fichier selon le format annoncé. */
  private async parseImportFile(
    format: ImportFormat,
    body: ImportQuestionsDto | undefined,
    file?: UploadedImportFile,
  ): Promise<ParsedImport> {
    if (file) {
      if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
        throw new ImportFileError("Fichier vide");
      }
      if (file.buffer.length > IMPORT_MAX_FILE_BYTES) {
        throw new ImportFileError(
          "Fichier trop volumineux (2 Mo au plus)",
          "too_large",
        );
      }
      const ext = /\.([A-Za-z0-9]+)$/.exec(file.originalname ?? "")?.[1];
      if (ext && !IMPORT_EXTENSIONS[format].includes(ext.toLowerCase())) {
        throw new ImportFileError(
          `Extension .${ext} incompatible avec le format ${format} (attendu : ${IMPORT_EXTENSIONS[
            format
          ]
            .map((e) => `.${e}`)
            .join(", ")})`,
          "unsupported_type",
        );
      }
    }

    if (format === "markdown") {
      let content: string;
      if (file) {
        content = decodeTextFile(file.buffer, "fichier Markdown");
      } else if (typeof body?.questions_content === "string") {
        if (Buffer.byteLength(body.questions_content) > IMPORT_MAX_FILE_BYTES) {
          throw new ImportFileError(
            "Contenu trop volumineux (2 Mo au plus)",
            "too_large",
          );
        }
        content = body.questions_content;
      } else {
        throw new ImportFileError(
          "Fichier (champ file) ou questions_content requis",
        );
      }
      let questions: CreateQuestionDto[];
      try {
        questions = this.parseMarkdownQuestions(
          content,
          body?.answers_content,
        );
      } catch (e) {
        if (e instanceof BadRequestException) {
          throw new ImportFileError(e.message);
        }
        throw e;
      }
      if (questions.length === 0) {
        throw new ImportFileError("Aucune question trouvée dans le fichier");
      }
      if (questions.length > IMPORT_MAX_ROWS) {
        throw new ImportFileError(
          `Trop de questions : ${IMPORT_MAX_ROWS} au plus`,
        );
      }
      return {
        candidates: questions.map((q, i) => ({
          row: i + 1,
          question: { ...q } as unknown as Record<string, unknown>,
        })),
        errors: [],
      };
    }

    if (!file) {
      throw new ImportFileError('Fichier requis (champ multipart "file")');
    }

    if (format === "csv") {
      const text = decodeTextFile(file.buffer, "CSV");
      const rows = parseCsv(text, { maxRecords: IMPORT_MAX_ROWS + 1 });
      return parseTabularRows(rows);
    }
    if (format === "xlsx") {
      const rows = await readXlsxRows(file.buffer, {
        maxRows: IMPORT_MAX_ROWS + 1,
      });
      return parseTabularRows(rows);
    }
    // kahoot : lignes de titre au-dessus de l'en-tête, bornées à part
    const rows = await readXlsxRows(file.buffer, {
      maxRows: IMPORT_MAX_ROWS + 31,
    });
    return parseKahootRows(rows, IMPORT_MAX_ROWS);
  }

  // ============================================================
  // HELPER
  // ============================================================

  /**
   * Vérifie que le quiz appartient à `creatorId`. Renvoie 404 dans les deux
   * cas (inexistant ou appartenant à un autre) pour ne pas révéler son
   * existence, comme `getQuizById`.
   */
  private async assertOwnership(quizId: string, creatorId: string) {
    const { data: quiz } = await this.supabase
      .from("quizzes")
      .select("creator_id")
      .eq("id", quizId)
      .single();

    if (!quiz || !creatorId || quiz.creator_id !== creatorId) {
      throw new NotFoundException("Quiz introuvable");
    }
  }
}
