import type { QuestionType } from "../common/utils/question-types.util";

/**
 * Génération de quiz par IA (issue #11) : limites et valeurs par défaut.
 * Toutes les limites sont documentées dans le README (section « Génération
 * de quiz par IA ») et dans la PR.
 */

/** Jeton d'injection du client Anthropic (null si ANTHROPIC_API_KEY absente). */
export const ANTHROPIC_CLIENT = "ANTHROPIC_CLIENT";

/** Modèle par défaut si AI_MODEL n'est pas défini. */
export const DEFAULT_AI_MODEL = "claude-sonnet-5-5";

/** Générations autorisées par utilisateur et par mois civil (UTC). */
export const DEFAULT_AI_MONTHLY_QUOTA = 3;

/** Délai d'attente d'un appel au fournisseur IA (ms), côté SDK. */
export const DEFAULT_AI_TIMEOUT_MS = 120_000;

/** Nouvelles tentatives du SDK (429, 5xx, coupure réseau). */
export const AI_MAX_RETRIES = 1;

/** Plafond de jetons de sortie (30 questions + réflexion du modèle). */
export const AI_MAX_OUTPUT_TOKENS = 16_000;

/** Taille maximale du PDF envoyé : 10 Mo. */
export const AI_PDF_MAX_BYTES = 10 * 1024 * 1024;

/** Taille maximale d'un champ texte multipart (octets, multer `fieldSize`). */
export const AI_FIELD_MAX_BYTES = 1024 * 1024;

/** Longueur maximale acceptée pour le champ `text` (caractères). */
export const AI_TEXT_FIELD_MAX_CHARS = 200_000;

/**
 * Texte du cours réellement envoyé au modèle : 60 000 caractères au plus
 * (environ 15 000 jetons). Au-delà, le texte est tronqué (début du document
 * conservé) et la réponse l'indique (`truncated: true`).
 */
export const AI_MAX_SOURCE_CHARS = 60_000;

/** En dessous, le contenu est jugé insuffisant pour générer des questions. */
export const AI_MIN_SOURCE_CHARS = 200;

/** Bornes du nombre de questions demandé. */
export const AI_MIN_QUESTIONS = 1;
export const AI_MAX_QUESTIONS = 30;

/** Longueur maximale du champ `level` (ex. « 4e », « Terminale »). */
export const AI_LEVEL_MAX_LENGTH = 50;

/**
 * Types que l'IA peut générer. `poll` est exclu : un sondage n'a pas de
 * bonne réponse à tirer du document.
 */
export const GENERATABLE_QUESTION_TYPES = [
  "single",
  "multiple",
  "true_false",
  "ordering",
  "short_answer",
] as const satisfies readonly QuestionType[];
export type GeneratableQuestionType =
  (typeof GENERATABLE_QUESTION_TYPES)[number];

/** Types demandés quand `types` est absent. */
export const DEFAULT_GENERATED_TYPES: GeneratableQuestionType[] = [
  "single",
  "multiple",
  "true_false",
];

/** Valeurs posées sur chaque question du brouillon (modifiables ensuite). */
export const GENERATED_QUESTION_MAX_POINTS = 100;
export const GENERATED_QUESTION_TIMER_SECONDS = 30;
