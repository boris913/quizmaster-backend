import { createHash, randomBytes, timingSafeEqual } from "crypto";

/** Modes d'une session (issue #10, migration 006). */
export const SESSION_MODES = ["live", "async"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/**
 * Moment où un devoir révèle le verdict et l'explication (issue #10) :
 * "each" après chaque réponse, "end" à la fin du devoir de l'élève.
 */
export const SHOW_EXPLANATIONS_MODES = ["each", "end"] as const;
export type ShowExplanationsMode = (typeof SHOW_EXPLANATIONS_MODES)[number];

/** Nom de l'en-tête HTTP qui porte le jeton de reprise. */
export const RESUME_TOKEN_HEADER = "x-resume-token";

/** Octets d'aléa du jeton de reprise (256 bits). */
export const RESUME_TOKEN_BYTES = 32;

/**
 * Tolérance réseau (ms) au-delà du chrono d'une question : une réponse reçue
 * dans cette marge est acceptée, son temps étant ramené à la durée du chrono.
 */
export const ASYNC_ANSWER_GRACE_MS = 1500;

/** Échéance maximale d'un devoir, en jours après sa création ou sa prolongation. */
export const MAX_DUE_IN_DAYS = 365;

/**
 * Jeton de reprise : 32 octets d'aléa cryptographique, encodés en base64url
 * (43 caractères). Remis une seule fois à l'élève ; seule son empreinte est
 * stockée (`hashResumeToken`).
 */
export function generateResumeToken(): string {
  return randomBytes(RESUME_TOKEN_BYTES).toString("base64url");
}

/** Empreinte SHA-256 (hex, 64 caractères) stockée dans `participants.resume_token`. */
export function hashResumeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Forme attendue d'un jeton de reprise (base64url, 43 caractères). */
export function isWellFormedResumeToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/**
 * Comparaison en temps constant de deux empreintes hexadécimales. Faux si
 * l'une est absente ou si les longueurs diffèrent.
 */
export function safeEqualHex(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Générateur pseudo-aléatoire déterministe (mulberry32) initialisé par `seed`. */
function seededRandom(seed: string): () => number {
  let state = createHash("sha256")
    .update(seed, "utf8")
    .digest()
    .readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mélange de Fisher-Yates déterministe : même graine et même entrée donnent
 * toujours le même ordre. Ne modifie pas le tableau reçu.
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const result = [...items];
  const random = seededRandom(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
