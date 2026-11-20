import { randomInt } from "crypto";

/**
 * Calcule les points obtenus pour une réponse.
 *
 * Formule :
 *   points = maxPoints × (1 - timeTakenMs / (timerSeconds * 1000))
 *   Minimum garanti pour une réponse juste dans le temps : 10 % des maxPoints
 *   Si réponse fausse ou arrivée après la fin du timer → 0
 *
 * Bornes (défense en profondeur, le temps doit être mesuré côté serveur) :
 *   - la fenêtre de réponse est [0, timerMs] inclus ; au-delà → 0 point ;
 *   - un temps négatif est ramené à 0 (jamais plus que maxPoints) ;
 *   - un temps non numérique (NaN, Infinity) est traité comme hors délai ;
 *   - `timerSeconds <= 0` (ou non numérique) : fenêtre vide, donc toute
 *     réponse est hors délai → 0 point. On ne lève pas d'erreur : la fonction
 *     est appelée pendant une partie en direct et la validation de la durée
 *     relève des DTO (`@Min(5)`), pas du calcul du score ;
 *   - le résultat est toujours un entier dans [0, maxPoints].
 */
export function calculatePoints(
  isCorrect: boolean,
  timeTakenMs: number,
  timerSeconds: number,
  maxPoints: number,
): number {
  if (!isCorrect) return 0;
  if (!Number.isFinite(maxPoints) || maxPoints <= 0) return 0;
  if (!Number.isFinite(timerSeconds) || timerSeconds <= 0) return 0;

  const timerMs = timerSeconds * 1000;
  if (!Number.isFinite(timeTakenMs) || timeTakenMs > timerMs) return 0;

  const boundedTime = Math.max(0, timeTakenMs);
  const ratio = 1 - boundedTime / timerMs;
  const raw = Math.round(maxPoints * ratio);
  const minimum = Math.round(maxPoints * 0.1); // 10% minimum

  return Math.min(maxPoints, Math.max(raw, minimum));
}

/**
 * Temps de réponse mesuré côté serveur, en millisecondes, à partir de l'heure
 * de début de la question (`sessions.question_start_time`) et de l'heure
 * serveur. Le client ne fournit jamais cette valeur.
 *
 * Renvoie `null` si l'heure de début est absente ou invalide.
 */
export function computeServerTimeTakenMs(
  questionStartTime: string | Date | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!questionStartTime) return null;
  const startMs = new Date(questionStartTime).getTime();
  if (!Number.isFinite(startMs)) return null;
  return Math.max(0, nowMs - startMs);
}

/**
 * Vérifie si la réponse d'un participant est correcte.
 * Supporte les questions à réponse unique et multiple.
 */
export function checkAnswer(
  submittedAnswers: string[],
  correctAnswers: string[],
  type: "single" | "multiple",
): boolean {
  if (!submittedAnswers || submittedAnswers.length === 0) return false;

  const submitted = [...submittedAnswers].sort();
  const correct = [...correctAnswers].sort();

  if (type === "single") {
    return submitted.length === 1 && submitted[0] === correct[0];
  }

  // Multiple: doit avoir exactement les bonnes réponses
  return (
    submitted.length === correct.length &&
    submitted.every((a, i) => a === correct[i])
  );
}

/**
 * Alphabet des codes de session : majuscules et chiffres, sans les caractères
 * visuellement ambigus `0 O 1 I L` (code recopié depuis un vidéoprojecteur).
 */
export const SESSION_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Longueur des codes de session. */
export const SESSION_CODE_LENGTH = 6;

/**
 * Génère un code de session aléatoire de 6 caractères pris dans
 * `SESSION_CODE_ALPHABET` (aléa cryptographique).
 */
export function generateSessionPassword(): string {
  let result = "";
  for (let i = 0; i < SESSION_CODE_LENGTH; i++) {
    result += SESSION_CODE_ALPHABET[randomInt(SESSION_CODE_ALPHABET.length)];
  }
  return result;
}

/**
 * Normalise un code de session saisi par un joueur : supprime tous les
 * espaces (y compris en tête et en fin) et passe en majuscules.
 * Aucun filtrage d'alphabet : les anciens codes (qui pouvaient contenir `L`)
 * restent acceptés.
 */
export function normalizeSessionCode(code: string): string {
  return code.trim().replace(/\s+/g, "").toUpperCase();
}

/**
 * Trie et calcule le classement depuis la liste des participants.
 * AMÉLIORATION AUDIT #3: Ajout des gaps et du podium
 */
export function buildLeaderboard(
  participants: Array<{
    id: string;
    pseudo: string;
    score: number;
    last_points?: number;
    answered_current?: boolean;
  }>,
): Array<{
  rank: number;
  participant_id: string;
  pseudo: string;
  score: number;
  last_points: number;
  answered_current: boolean;
  gap_to_next: number | null;
  gap_to_podium: number | null;
  on_podium: boolean;
}> {
  const sorted = [...participants].sort((a, b) => b.score - a.score);

  return sorted.map((p, index) => {
    const rank = index + 1;
    const gapToNext = index > 0 ? sorted[index - 1].score - p.score : null;
    const gapToPodium = rank > 3 ? (sorted[2]?.score ?? 0) - p.score : null;

    return {
      rank,
      participant_id: p.id,
      pseudo: p.pseudo,
      score: p.score,
      last_points: p.last_points ?? 0,
      answered_current: p.answered_current ?? false,
      gap_to_next: gapToNext,
      gap_to_podium: gapToPodium,
      on_podium: rank <= 3,
    };
  });
}
