/**
 * Agrégation des résultats d'une session (issue #4).
 *
 * Fonctions pures, sans accès à la base : le service lit les lignes Supabase
 * puis délègue le calcul à `buildSessionResults`, ce qui permet de tester
 * l'agrégation sans mock de requêtes.
 *
 * Conventions de calcul :
 * - Une ligne `participant_answers` par participant et par question jouée
 *   (réponse `answered`, ou `timeout` insérée à la fin du chrono).
 * - Précision (`accuracy`, 0..1) = réponses correctes / lignes de réponse,
 *   timeouts compris (un timeout compte comme une réponse fausse).
 * - Les questions dont le type n'est pas notable (`poll`, à venir avec #05)
 *   sont exclues de toutes les précisions ; leur `accuracy` vaut 0.
 * - `avgTimeMs` = moyenne de `time_taken_ms` sur les réponses `answered`
 *   uniquement (un timeout n'a pas de temps) ; 0 s'il n'y en a aucune.
 * - `completionRate` = réponses `answered` / (participants × questions
 *   jouées). Une question est « jouée » si elle a au moins une ligne de
 *   réponse : une session arrêtée avant la fin n'est donc pas pénalisée.
 * - Une ligne dont la question n'appartient pas au quiz, ou dont le
 *   participant n'appartient pas à la session, est ignorée.
 */

/** Types de question exclus du calcul de précision (pas de bonne réponse). */
export const UNGRADED_QUESTION_TYPES: readonly string[] = ["poll"];

export function isGradedQuestionType(type: string): boolean {
  return !UNGRADED_QUESTION_TYPES.includes(type);
}

// ------------------------------------------------------------
// Lignes lues en base
// ------------------------------------------------------------

export interface ResultsSessionRow {
  id: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  quizzes?: { title?: string | null } | null;
}

export interface ResultsQuestionRow {
  id: string;
  order_index: number;
  text: string;
  type: string;
  options: { id: string; text?: string }[] | null;
  correct_answers: string[] | null;
}

export interface ResultsParticipantRow {
  id: string;
  pseudo: string;
  score: number | null;
}

export interface ResultsAnswerRow {
  participant_id: string;
  question_id: string;
  answers: string[] | null;
  status: string;
  is_correct: boolean | null;
  time_taken_ms: number | null;
}

// ------------------------------------------------------------
// Contrat d'API (GET /api/sessions/:id/results)
// ------------------------------------------------------------

export interface SessionResults {
  session: {
    id: string;
    quizTitle: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    participantCount: number;
  };
  summary: { accuracy: number; avgScore: number; completionRate: number };
  perQuestion: QuestionResult[];
  perParticipant: ParticipantResult[];
}

export interface QuestionResult {
  questionId: string;
  orderIndex: number;
  text: string;
  type: string;
  accuracy: number;
  avgTimeMs: number;
  answerDistribution: Record<string, number>;
  correctAnswers: string[];
}

export interface ParticipantResult {
  participantId: string;
  pseudo: string;
  score: number;
  accuracy: number;
  answered: number;
  timeouts: number;
  avgTimeMs: number;
}

// ------------------------------------------------------------
// Calcul
// ------------------------------------------------------------

/** Ratio arrondi à 4 décimales, 0 si le dénominateur est nul. */
function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function mean(values: number[], decimals = 0): number {
  if (values.length === 0) return 0;
  const factor = 10 ** decimals;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.round(avg * factor) / factor;
}

function answeredTimes(rows: ResultsAnswerRow[]): number[] {
  return rows
    .filter((a) => a.status === "answered" && a.time_taken_ms != null)
    .map((a) => a.time_taken_ms as number);
}

export function buildSessionResults(input: {
  session: ResultsSessionRow;
  questions: ResultsQuestionRow[];
  participants: ResultsParticipantRow[];
  answers: ResultsAnswerRow[];
}): SessionResults {
  const questions = [...input.questions].sort(
    (a, b) => a.order_index - b.order_index,
  );
  const participants = input.participants;
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const participantIds = new Set(participants.map((p) => p.id));
  const answers = input.answers.filter(
    (a) =>
      questionById.has(a.question_id) && participantIds.has(a.participant_id),
  );

  const isGradedRow = (a: ResultsAnswerRow) =>
    isGradedQuestionType(questionById.get(a.question_id)!.type);

  const perQuestion: QuestionResult[] = questions.map((q) => {
    const rows = answers.filter((a) => a.question_id === q.id);

    const answerDistribution: Record<string, number> = {};
    for (const option of q.options ?? []) answerDistribution[option.id] = 0;
    for (const row of rows) {
      if (row.status !== "answered") continue;
      for (const optionId of new Set(row.answers ?? [])) {
        answerDistribution[optionId] = (answerDistribution[optionId] ?? 0) + 1;
      }
    }

    const graded = isGradedQuestionType(q.type);
    return {
      questionId: q.id,
      orderIndex: q.order_index,
      text: q.text,
      type: q.type,
      accuracy: graded
        ? ratio(rows.filter((a) => a.is_correct).length, rows.length)
        : 0,
      avgTimeMs: mean(answeredTimes(rows)),
      answerDistribution,
      correctAnswers: q.correct_answers ?? [],
    };
  });

  const perParticipant: ParticipantResult[] = participants.map((p) => {
    const rows = answers.filter((a) => a.participant_id === p.id);
    const gradedRows = rows.filter(isGradedRow);
    return {
      participantId: p.id,
      pseudo: p.pseudo,
      score: p.score ?? 0,
      accuracy: ratio(
        gradedRows.filter((a) => a.is_correct).length,
        gradedRows.length,
      ),
      answered: rows.filter((a) => a.status === "answered").length,
      timeouts: rows.filter((a) => a.status === "timeout").length,
      avgTimeMs: mean(answeredTimes(rows)),
    };
  });

  const gradedAnswers = answers.filter(isGradedRow);
  const playedQuestions = new Set(answers.map((a) => a.question_id)).size;

  return {
    session: {
      id: input.session.id,
      quizTitle: input.session.quizzes?.title ?? "",
      status: input.session.status,
      startedAt: input.session.started_at ?? null,
      endedAt: input.session.ended_at ?? null,
      participantCount: participants.length,
    },
    summary: {
      accuracy: ratio(
        gradedAnswers.filter((a) => a.is_correct).length,
        gradedAnswers.length,
      ),
      avgScore: mean(
        participants.map((p) => p.score ?? 0),
        2,
      ),
      completionRate: ratio(
        answers.filter((a) => a.status === "answered").length,
        participants.length * playedQuestions,
      ),
    },
    perQuestion,
    perParticipant,
  };
}
