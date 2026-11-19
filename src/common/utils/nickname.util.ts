// ============================================================
// Modération et génération des pseudos (issue #5)
// ============================================================
import {
  GENERATOR_ADJECTIVES,
  GENERATOR_NOUNS,
  GeneratorAdjective,
  GeneratorNoun,
  MILD_TERMS,
  NICKNAME_EXCEPTIONS,
  SEVERE_TERMS,
} from "./nickname-wordlists";

export type NicknameMode = "free" | "generated";
export const NICKNAME_MODES: readonly NicknameMode[] = ["free", "generated"];

/** Messages d'erreur renvoyés au participant (REST et WebSocket). */
export const NICKNAME_ERRORS = {
  notAllowed: "Ce pseudo n'est pas autorisé. Merci d'en choisir un autre.",
  mustBeGenerated:
    "Dans cette session, le pseudo doit être choisi parmi les propositions.",
  kicked: "Vous avez été exclu de cette session par l'enseignant.",
} as const;

// ============================================================
// NORMALISATION
// ============================================================

/** Substitutions « leet speak » appliquées avant la comparaison. */
const LEET_MAP: Record<string, string> = {
  "4": "a",
  "@": "a",
  "3": "e",
  "1": "i",
  "!": "i",
  "0": "o",
  "5": "s",
  $: "s",
  "7": "t",
};

/**
 * Normalise un pseudo pour la modération :
 * séparation du camelCase, minuscules, suppression des accents, leet speak,
 * puis tout caractère autre qu'une lettre a-z devient un espace.
 *
 *   "GrosM3rde"   → "gros merde"
 *   "Député_42"   → "depute a"
 */
export function normalizeForModeration(input: string, leet = true): string {
  let text = (input ?? "")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (leet) text = text.replace(/[4@3105$7!]/g, (c) => LEET_MAP[c] ?? c);
  return text.replace(/[^a-z]+/g, " ").trim();
}

/** Expression qui tolère les lettres répétées : "con" → /c+o+n+/. */
function termPattern(term: string): string {
  return term
    .replace(/(.)\1+/g, "$1")
    .split("")
    .map((c) => `${c}+`)
    .join("");
}

const SEVERE_REGEXES = SEVERE_TERMS.map((t) => new RegExp(termPattern(t)));
const MILD_REGEXES = MILD_TERMS.map((t) => new RegExp(`^${termPattern(t)}$`));
// Les plus longues d'abord, pour neutraliser « dominique » avant « unique ».
const EXCEPTIONS = [...NICKNAME_EXCEPTIONS].sort((a, b) => b.length - a.length);

/**
 * Vrai si le pseudo est acceptable.
 *
 * - termes graves : refusés n'importe où, y compris à l'intérieur d'un mot et
 *   à travers les séparateurs ("n.a.z.i") ; les mots de `NICKNAME_EXCEPTIONS`
 *   (« Député », « Dominique »…) sont neutralisés avant la recherche ;
 * - termes modérés : refusés comme mot entier ou si le pseudo entier s'y
 *   réduit ("C-0-N"), mais pas à l'intérieur d'un mot (« Constance »).
 */
export function isNicknameAllowed(pseudo: string): boolean {
  const normalized = normalizeForModeration(pseudo);
  if (!normalized) return false;

  // Deux lectures : avec leet speak ("m3rd3") et chiffres comme séparateurs
  // ("merde42", où "4" ne doit pas devenir un "a" collé au mot).
  return [normalized, normalizeForModeration(pseudo, false)].every(
    (text) => !text || isNormalizedTextAllowed(text),
  );
}

function isNormalizedTextAllowed(normalized: string): boolean {
  const words = normalized.split(" ");
  const compact = words.join("");

  let severeText = compact;
  for (const exception of EXCEPTIONS) {
    severeText = severeText.split(exception).join("|");
  }
  if (SEVERE_REGEXES.some((re) => re.test(severeText))) return false;

  const candidates = [...words, compact];
  return !MILD_REGEXES.some((re) => candidates.some((w) => re.test(w)));
}

// ============================================================
// GÉNÉRATEUR
// ============================================================

export function formatGeneratedNickname(
  noun: GeneratorNoun,
  adjective: GeneratorAdjective,
): string {
  return `${noun.word} ${adjective[noun.gender]}`;
}

/**
 * Pseudo aléatoire « Nom Adjectif » accordé en genre :
 * « Loutre Curieuse », « Hibou Curieux ».
 */
export function generateNickname(random: () => number = Math.random): string {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  return formatGeneratedNickname(
    pick(GENERATOR_NOUNS),
    pick(GENERATOR_ADJECTIVES),
  );
}

/**
 * `count` propositions distinctes, absentes de `exclude` (pseudos déjà pris
 * dans la session, comparés sans tenir compte de la casse).
 */
export function generateNicknameSuggestions(
  count = 3,
  exclude: Iterable<string> = [],
  random: () => number = Math.random,
): string[] {
  const taken = new Set([...exclude].map((p) => p.toLowerCase()));
  const result: string[] = [];
  const maxAttempts = count * 50;

  for (let i = 0; i < maxAttempts && result.length < count; i++) {
    const candidate = generateNickname(random);
    const key = candidate.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    result.push(candidate);
  }
  return result;
}

let generatedSet: Set<string> | null = null;

/** Vrai si `pseudo` est une combinaison que le générateur peut produire. */
export function isGeneratedNickname(pseudo: string): boolean {
  if (!generatedSet) {
    generatedSet = new Set();
    for (const noun of GENERATOR_NOUNS) {
      for (const adjective of GENERATOR_ADJECTIVES) {
        generatedSet.add(
          formatGeneratedNickname(noun, adjective).toLowerCase(),
        );
      }
    }
  }
  return generatedSet.has((pseudo ?? "").trim().toLowerCase());
}

/**
 * Vérifie un pseudo selon le mode de la session. Renvoie le message d'erreur
 * à afficher, ou `null` si le pseudo est accepté.
 */
export function getNicknameError(
  pseudo: string,
  mode: NicknameMode | string | null | undefined,
): string | null {
  if (mode === "generated") {
    return isGeneratedNickname(pseudo) ? null : NICKNAME_ERRORS.mustBeGenerated;
  }
  return isNicknameAllowed(pseudo) ? null : NICKNAME_ERRORS.notAllowed;
}
