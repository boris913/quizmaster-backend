/**
 * Calcule les points obtenus pour une réponse correcte.
 *
 * Formule :
 *   points = maxPoints × (1 - timeTakenMs / (timerSeconds * 1000))
 *   Minimum garanti : 10% des maxPoints
 *   Si réponse fausse ou timeout → 0
 */
export function calculatePoints(
  isCorrect: boolean,
  timeTakenMs: number,
  timerSeconds: number,
  maxPoints: number,
): number {
  if (!isCorrect) return 0;

  const timerMs = timerSeconds * 1000;
  const ratio = 1 - timeTakenMs / timerMs;
  const raw = Math.round(maxPoints * ratio);
  const minimum = Math.round(maxPoints * 0.1); // 10% minimum

  return Math.max(raw, minimum);
}

/**
 * Vérifie si la réponse d'un participant est correcte.
 * Supporte les questions à réponse unique et multiple.
 */
export function checkAnswer(
  submittedAnswers: string[],
  correctAnswers: string[],
  type: 'single' | 'multiple',
): boolean {
  if (!submittedAnswers || submittedAnswers.length === 0) return false;

  const submitted = [...submittedAnswers].sort();
  const correct = [...correctAnswers].sort();

  if (type === 'single') {
    return submitted.length === 1 && submitted[0] === correct[0];
  }

  // Multiple: doit avoir exactement les bonnes réponses
  return (
    submitted.length === correct.length &&
    submitted.every((a, i) => a === correct[i])
  );
}

/**
 * Génère un mot de passe de session aléatoire (6 caractères alphanumériques).
 */
export function generateSessionPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Trie et calcule le classement depuis la liste des participants.
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
}> {
  return [...participants]
    .sort((a, b) => b.score - a.score)
    .map((p, index) => ({
      rank: index + 1,
      participant_id: p.id,
      pseudo: p.pseudo,
      score: p.score,
      last_points: p.last_points ?? 0,
      answered_current: p.answered_current ?? false,
    }));
}
