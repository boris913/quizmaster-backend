import { randomInt } from "crypto";

/**
 * Types de question (issue #7, migration 005).
 *
 * Sémantique de `questions.correct_answers` (TEXT[]) par type :
 * - `single`       : un id d'option (`["B"]`) ;
 * - `multiple`     : un ou plusieurs ids d'option (`["A", "C"]`) ;
 * - `true_false`   : `["true"]` ou `["false"]` (options fixes `true`/`false`) ;
 * - `ordering`     : TOUS les ids d'option, dans l'ordre attendu ;
 * - `short_answer` : variantes acceptées (texte libre), sans options ;
 * - `poll`         : `[]` (sondage, jamais juste, 0 point, non noté).
 */
export const QUESTION_TYPES = [
  "single",
  "multiple",
  "true_false",
  "ordering",
  "short_answer",
  "poll",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** Types de question exclus du calcul de précision (pas de bonne réponse). */
export const UNGRADED_QUESTION_TYPES: readonly string[] = ["poll"];

/** Vrai si le type de question est noté (tout sauf `poll`). */
export function isGradedQuestionType(type: string | null | undefined): boolean {
  return !UNGRADED_QUESTION_TYPES.includes(type ?? "");
}

/** Ids d'option des questions `single` / `multiple` (2 à 4 options). */
export const CHOICE_OPTION_IDS = ["A", "B", "C", "D"] as const;
/** Ids d'option des questions `ordering` (3 à 6) et `poll` (2 à 6). */
export const EXTENDED_OPTION_IDS = ["A", "B", "C", "D", "E", "F"] as const;
/** Ids d'option d'une question `true_false`. */
export const TRUE_FALSE_OPTION_IDS = ["true", "false"] as const;
/** Tous les ids d'option acceptés par le DTO (règles fines par type ci-dessous). */
export const ALL_OPTION_IDS: readonly string[] = [
  ...EXTENDED_OPTION_IDS,
  ...TRUE_FALSE_OPTION_IDS,
];

/** Options enregistrées par défaut pour une question `true_false`. */
export const DEFAULT_TRUE_FALSE_OPTIONS: ReadonlyArray<{
  id: string;
  text: string;
}> = [
  { id: "true", text: "Vrai" },
  { id: "false", text: "Faux" },
];

/** Limites des réponses courtes. */
export const SHORT_ANSWER_MAX_VARIANTS = 20;
export const SHORT_ANSWER_VARIANT_MAX_LENGTH = 100;
/** Longueur maximale d'une réponse courte soumise par un joueur. */
export const SHORT_ANSWER_SUBMISSION_MAX_LENGTH = 200;
/** Nombre maximal d'entrées dans la distribution d'une réponse courte. */
export const SHORT_ANSWER_DISTRIBUTION_LIMIT = 20;

export interface QuestionOptionLike {
  id: string;
  text?: string;
}

export interface QuestionShape {
  type: string;
  options?: QuestionOptionLike[] | null;
  correct_answers?: string[] | null;
}

/**
 * Normalise une réponse courte pour la comparaison : casse, accents
 * (décomposition Unicode puis retrait des diacritiques), apostrophes
 * typographiques, espaces (trim + espaces multiples réduits à un seul) et
 * ponctuation finale (`. ! ? , ; : …`) ignorés.
 *
 * Ex. : `"  Élysée   Palace ! "` → `"elysee palace"`.
 */
export function normalizeShortAnswer(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[‘’ʼ`´]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!?,;:…]+$/u, "")
    .trim();
}

function duplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * Règles de validation par type (DTO et import Markdown). Renvoie la liste
 * des erreurs, vide si la question est valide.
 */
export function validateQuestionByType(q: QuestionShape): string[] {
  const errors: string[] = [];
  const type = q.type;
  if (!(QUESTION_TYPES as readonly string[]).includes(type)) {
    return [`type doit valoir ${QUESTION_TYPES.join(", ")}`];
  }
  const options = Array.isArray(q.options) ? q.options : [];
  const correct = Array.isArray(q.correct_answers) ? q.correct_answers : [];
  const ids = options.map((o) => o?.id);

  if (duplicates(ids)) errors.push("les ids d'option doivent être uniques");

  const checkIds = (allowed: readonly string[], min: number, max: number) => {
    if (options.length < min || options.length > max) {
      errors.push(
        `une question ${type} doit avoir entre ${min} et ${max} options`,
      );
    }
    const bad = ids.filter((id) => !allowed.includes(id));
    if (bad.length) {
      errors.push(
        `ids d'option invalides pour ${type} : ${bad.join(", ")} (attendus : ${allowed.join(", ")})`,
      );
    }
  };

  const checkCorrectInOptions = () => {
    for (const answer of correct) {
      if (!ids.includes(answer)) {
        errors.push(
          `la réponse correcte "${answer}" ne correspond à aucune option`,
        );
      }
    }
  };

  switch (type) {
    case "single":
      checkIds(CHOICE_OPTION_IDS, 2, 4);
      if (correct.length !== 1) {
        errors.push("une question single attend exactement 1 bonne réponse");
      }
      checkCorrectInOptions();
      break;
    case "multiple":
      checkIds(CHOICE_OPTION_IDS, 2, 4);
      if (correct.length < 1) {
        errors.push("une question multiple attend au moins 1 bonne réponse");
      }
      if (duplicates(correct)) {
        errors.push("bonnes réponses en double");
      }
      checkCorrectInOptions();
      break;
    case "true_false":
      if (options.length > 0) {
        const sorted = [...ids].sort().join(",");
        if (options.length !== 2 || sorted !== "false,true") {
          errors.push(
            'une question true_false a exactement 2 options fixes : "true" et "false" (ou aucune option)',
          );
        }
      }
      if (
        correct.length !== 1 ||
        !(TRUE_FALSE_OPTION_IDS as readonly string[]).includes(correct[0])
      ) {
        errors.push(
          'une question true_false attend correct_answers ["true"] ou ["false"]',
        );
      }
      break;
    case "ordering": {
      checkIds(EXTENDED_OPTION_IDS, 3, 6);
      const isPermutation =
        correct.length === ids.length &&
        !duplicates(correct) &&
        correct.every((id) => ids.includes(id));
      if (!isPermutation) {
        errors.push(
          "une question ordering attend dans correct_answers tous les ids d'option, une fois chacun, dans l'ordre attendu",
        );
      }
      break;
    }
    case "short_answer": {
      if (options.length > 0) {
        errors.push("une question short_answer n'a pas d'options");
      }
      if (correct.length < 1 || correct.length > SHORT_ANSWER_MAX_VARIANTS) {
        errors.push(
          `une question short_answer attend entre 1 et ${SHORT_ANSWER_MAX_VARIANTS} variantes acceptées`,
        );
      }
      for (const variant of correct) {
        if (typeof variant !== "string" || !normalizeShortAnswer(variant)) {
          errors.push("variante acceptée vide");
        } else if (variant.length > SHORT_ANSWER_VARIANT_MAX_LENGTH) {
          errors.push(
            `variante acceptée trop longue (${SHORT_ANSWER_VARIANT_MAX_LENGTH} caractères au plus)`,
          );
        }
      }
      break;
    }
    case "poll":
      checkIds(EXTENDED_OPTION_IDS, 2, 6);
      if (correct.length > 0) {
        errors.push("une question poll n'a pas de bonne réponse");
      }
      break;
  }

  return errors;
}

/** Mélange de Fisher-Yates (aléa cryptographique), sans modifier l'entrée. */
export function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Options d'une question `ordering` envoyées aux joueurs : mélangées, et
 * jamais dans l'ordre attendu quand c'est évitable (au moins 2 options
 * distinctes).
 */
export function shuffleOrderingOptions<T extends QuestionOptionLike>(
  options: readonly T[],
  correctOrder: readonly string[],
): T[] {
  if (options.length < 2) return [...options];
  const expected = correctOrder.join("\u0000");
  let shuffled = shuffle(options);
  for (
    let attempt = 0;
    attempt < 20 && shuffled.map((o) => o.id).join("\u0000") === expected;
    attempt++
  ) {
    shuffled = shuffle(options);
  }
  return shuffled;
}

/**
 * Réattribue au hasard les ids (lettres) des options d'une question
 * `ordering` à l'enregistrement, pour que l'ordre alphabétique des ids ne
 * trahisse pas l'ordre attendu (un éditeur saisit naturellement A, B, C dans
 * le bon ordre). Les options sont stockées triées par id ; `correct_answers`
 * est traduit avec la même correspondance (même séquence de textes).
 */
export function scrambleOrderingIds(
  options: QuestionOptionLike[],
  correctAnswers: string[],
): { options: { id: string; text: string }[]; correct_answers: string[] } {
  const newIds = shuffle(options.map((o) => o.id));
  const mapping = new Map(options.map((o, i) => [o.id, newIds[i]]));
  return {
    options: options
      .map((o) => ({ id: mapping.get(o.id)!, text: o.text ?? "" }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    correct_answers: correctAnswers.map((id) => mapping.get(id) ?? id),
  };
}

/**
 * Distribution des réponses d'une question, selon son type :
 * - `single`, `multiple`, `true_false`, `poll` : nombre de participants par
 *   id d'option (toutes les options présentes, 0 par défaut ; chaque option
 *   comptée une fois par participant) ;
 * - `ordering` : `{}` (chaque réponse contient toutes les options : la
 *   répartition par option n'a pas de sens ; juste/faux = `accuracy`) ;
 * - `short_answer` : nombre de participants par réponse normalisée
 *   (`normalizeShortAnswer`), limité aux `SHORT_ANSWER_DISTRIBUTION_LIMIT`
 *   réponses les plus fréquentes.
 *
 * `answersList` ne contient que des réponses données (pas de timeout).
 */
export function buildAnswerDistribution(
  type: string,
  options: QuestionOptionLike[] | null | undefined,
  answersList: string[][],
): Record<string, number> {
  if (type === "ordering") return {};

  if (type === "short_answer") {
    const counts = new Map<string, number>();
    for (const answers of answersList) {
      const key = normalizeShortAnswer(answers?.[0]);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries(
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, SHORT_ANSWER_DISTRIBUTION_LIMIT),
    );
  }

  const optionIds = new Set((options ?? []).map((o) => o.id));
  const distribution: Record<string, number> = {};
  for (const id of optionIds) distribution[id] = 0;
  for (const answers of answersList) {
    for (const id of new Set(answers ?? [])) {
      if (optionIds.has(id)) distribution[id]++;
    }
  }
  return distribution;
}
