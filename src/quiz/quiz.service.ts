import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_CLIENT } from "../database/database.module";
import {
  CreateQuizDto,
  UpdateQuizDto,
  CreateQuestionDto,
  ImportQuestionsDto,
  ImageUploadUrlDto,
  IMAGE_URL_MAX_LENGTH,
  QUESTION_IMAGE_CONTENT_TYPES,
  QUESTION_IMAGE_MAX_BYTES,
} from "./dto/quiz.dto";
import { randomUUID } from "crypto";
import {
  DEFAULT_TRUE_FALSE_OPTIONS,
  QUESTION_TYPES,
  QuestionType,
  normalizeShortAnswer,
  scrambleOrderingIds,
  validateQuestionByType,
} from "../common/utils/question-types.util";

/** Bucket Supabase Storage des images de question (issue #7). */
export const QUESTION_IMAGES_BUCKET = "question-images";

/** Extension de fichier par type MIME accepté. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

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
