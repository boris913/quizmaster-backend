import {
  Injectable,
  Inject,
  BadRequestException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_CLIENT } from "../database/database.module";
import {
  calculatePoints,
  checkAnswer,
  buildLeaderboard,
  computeClassProgress,
  computeServerTimeTakenMs,
  ScoringMode,
} from "../common/utils/scoring.util";
import {
  buildAnswerDistribution,
  isGradedQuestionType,
  SHORT_ANSWER_SUBMISSION_MAX_LENGTH,
} from "../common/utils/question-types.util";
import { fetchAllRows } from "../session/results/fetch-all-rows";

/** Nombre maximal d'éléments dans une réponse soumise (6 options au plus). */
const MAX_SUBMITTED_ANSWERS = 6;

/**
 * Valide la forme d'une réponse soumise par un joueur (issue #7) : tableau
 * de chaînes, au plus 6 éléments ; pour `short_answer`, un seul texte
 * rogné, de 200 caractères au plus. Lève une 400 sinon.
 */
export function sanitizeSubmittedAnswers(
  type: string,
  answers: unknown,
): string[] {
  if (
    !Array.isArray(answers) ||
    answers.length > MAX_SUBMITTED_ANSWERS ||
    !answers.every((a) => typeof a === "string")
  ) {
    throw new BadRequestException("Réponse invalide");
  }
  if (type === "short_answer") {
    if (answers.length > 1) throw new BadRequestException("Réponse invalide");
    const text = (answers[0] ?? "").trim();
    if (text.length > SHORT_ANSWER_SUBMISSION_MAX_LENGTH) {
      throw new BadRequestException(
        `Réponse trop longue (${SHORT_ANSWER_SUBMISSION_MAX_LENGTH} caractères au plus)`,
      );
    }
    return text ? [text] : [];
  }
  return answers as string[];
}

/** Type de la question jointe à une ligne `participant_answers` (`questions (type)`). */
function joinedQuestionType(row: { questions?: unknown }): string | null {
  const q: any = Array.isArray(row.questions)
    ? row.questions[0]
    : row.questions;
  return typeof q?.type === "string" ? q.type : null;
}

/**
 * Réponse live arrivée alors qu'une ligne existe déjà pour ce participant et
 * cette question (typiquement le timeout inséré à la clôture, course
 * réponse/timeout). Le gateway la traduit en "answer:too_late".
 */
export const ANSWER_ALREADY_RECORDED =
  "Une réponse est déjà enregistrée pour cette question";

export interface SubmitAnswerParams {
  participantId: string;
  sessionId: string;
  questionId: string;
  answers: string[];
  /**
   * Horodatage serveur de réception de la réponse (ms). Par défaut `Date.now()`.
   * Le temps de réponse est toujours calculé côté serveur à partir de
   * `sessions.question_start_time` : aucune durée fournie par le client n'est
   * prise en compte.
   */
  receivedAtMs?: number;
}

export interface AnswerResult {
  isCorrect: boolean;
  pointsEarned: number;
  timeTakenMs: number;
  correctAnswers: string[];
  totalScore: number;
  rank: number;
  gapToNext: number | null;
  gapToPodium: number | null;
  onPodium: boolean;
}

/** Données de la question nécessaires au calcul des statistiques. */
export interface QuestionForStats {
  id: string;
  /** Type de la question (issue #7) ; absent = "single" (rétrocompatible). */
  type?: string;
  options: Array<{ id: string }>;
  correct_answers: string[];
}

/** Statistiques d'une question clôturée (issue #6). */
export interface QuestionStats {
  questionId: string;
  /** Type de la question (issue #7). */
  type: string;
  /** Répartition des réponses selon le type, voir `buildAnswerDistribution`. */
  distribution: Record<string, number>;
  correctAnswers: string[];
  /**
   * Pourcentage entier (0-100) de bonnes réponses parmi `totalParticipants`.
   * 0 pour une question non notée (poll).
   */
  accuracy: number;
  /** Faux pour un sondage (poll), exclu des précisions. */
  graded: boolean;
  answeredCount: number;
  totalParticipants: number;
  /** Réponse de chaque participant actif ayant répondu (pour "question:reveal"). */
  answersByParticipant: Map<string, { answers: string[]; isCorrect: boolean }>;
}

@Injectable()
export class ParticipantService {
  private readonly logger = new Logger(ParticipantService.name);

  constructor(@Inject(SUPABASE_CLIENT) private supabase: SupabaseClient) {}

  /**
   * Enregistre la réponse d'un participant et calcule les points.
   *
   * Le temps de réponse est mesuré côté serveur : heure de réception moins
   * `sessions.question_start_time`. Une réponse arrivée après la fin du timer
   * rapporte 0 point (voir `calculatePoints`).
   */
  async submitAnswer(params: SubmitAnswerParams): Promise<AnswerResult> {
    const { participantId, sessionId, questionId } = params;
    const receivedAtMs = params.receivedAtMs ?? Date.now();

    // Vérifier que le participant n'a pas déjà répondu à cette question
    const { data: existing } = await this.supabase
      .from("participant_answers")
      .select("id")
      .eq("participant_id", participantId)
      .eq("question_id", questionId)
      .single();

    if (existing) {
      throw new BadRequestException("Vous avez déjà répondu à cette question");
    }

    // Récupérer la question
    const { data: question, error: qError } = await this.supabase
      .from("questions")
      .select("*")
      .eq("id", questionId)
      .single();

    if (qError || !question) {
      throw new BadRequestException("Question introuvable");
    }

    // Forme de la réponse selon le type (issue #7)
    const answers = sanitizeSubmittedAnswers(question.type, params.answers);

    // Vérifier si la réponse est correcte (poll : jamais, 0 point)
    const isCorrect = checkAnswer(
      answers,
      question.correct_answers,
      question.type,
    );

    // Temps de réponse calculé côté serveur uniquement
    const { data: session } = await this.supabase
      .from("sessions")
      .select(
        "question_start_time, scoring_mode, quizzes (use_global_timer, global_timer_seconds)",
      )
      .eq("id", sessionId)
      .single();

    const serverTimeTaken = computeServerTimeTakenMs(
      session?.question_start_time,
      receivedAtMs,
    );
    if (serverTimeTaken === null) {
      throw new BadRequestException("Aucune question en cours");
    }

    // Même durée que le timer réellement appliqué par le gateway
    const quiz: any = Array.isArray(session?.quizzes)
      ? session.quizzes[0]
      : session?.quizzes;
    const timerSeconds = quiz?.use_global_timer
      ? quiz.global_timer_seconds
      : question.timer_seconds;
    const timerMs = timerSeconds * 1000;

    // Calculer les points avec le temps mesuré par le serveur, selon le
    // mode de score de la session (issue #8 ; "speed" si absent)
    const scoringMode: ScoringMode =
      session?.scoring_mode === "accuracy" ? "accuracy" : "speed";
    const pointsEarned = calculatePoints(
      isCorrect,
      serverTimeTaken,
      timerSeconds,
      question.max_points,
      scoringMode,
    );
    // Valeur enregistrée bornée à la durée du timer (une réponse hors délai
    // vaut 0 point de toute façon)
    const validTimeTaken =
      Number.isFinite(timerMs) && timerMs > 0
        ? Math.min(serverTimeTaken, timerMs)
        : serverTimeTaken;

    // Insérer la réponse dans la base
    const { error: answerError } = await this.supabase
      .from("participant_answers")
      .insert({
        participant_id: participantId,
        session_id: sessionId,
        question_id: questionId,
        answers,
        time_taken_ms: validTimeTaken,
        points_earned: pointsEarned,
        is_correct: isCorrect,
        status: "answered",
      });

    if (answerError) {
      // Index unique (participant_id, question_id), migration 006 : une ligne
      // (le timeout de la clôture) a été insérée entre la vérification
      // ci-dessus et cette insertion. Aucun point n'est compté.
      if (answerError.code === "23505") {
        throw new ConflictException(ANSWER_ALREADY_RECORDED);
      }
      throw new Error(`Erreur enregistrement réponse: ${answerError.message}`);
    }

    // Mettre à jour le score du participant
    await this.incrementParticipantScore(participantId, pointsEarned);

    // AMÉLIORATION AUDIT #3: Calculer le classement avec gaps
    const leaderboard = await this.buildSessionLeaderboard(
      sessionId,
      questionId,
    );
    const participantEntry = leaderboard.find(
      (e) => e.participant_id === participantId,
    );

    return {
      isCorrect,
      pointsEarned,
      timeTakenMs: validTimeTaken,
      correctAnswers: question.correct_answers,
      totalScore: participantEntry?.score ?? 0,
      rank: participantEntry?.rank ?? 0,
      gapToNext: participantEntry?.gap_to_next ?? null,
      gapToPodium: participantEntry?.gap_to_podium ?? null,
      onPodium: participantEntry?.on_podium ?? false,
    };
  }

  /**
   * Marque tous les participants sans réponse à une question comme timeout.
   */
  async processTimeouts(sessionId: string, questionId: string): Promise<void> {
    // Récupérer tous les participants actifs de la session
    const { data: participants } = await this.supabase
      .from("participants")
      .select("id")
      .eq("session_id", sessionId)
      .neq("status", "disconnected")
      .neq("status", "kicked");

    if (!participants) return;

    // Récupérer ceux qui ont répondu
    const { data: answered } = await this.supabase
      .from("participant_answers")
      .select("participant_id")
      .eq("session_id", sessionId)
      .eq("question_id", questionId);

    const answeredIds = new Set(answered?.map((a) => a.participant_id) || []);
    const timedOutParticipants = participants.filter(
      (p) => !answeredIds.has(p.id),
    );

    if (timedOutParticipants.length === 0) return;

    // Insérer des enregistrements timeout pour chacun
    const timeoutRecords = timedOutParticipants.map((p) => ({
      participant_id: p.id,
      session_id: sessionId,
      question_id: questionId,
      answers: [],
      time_taken_ms: null,
      points_earned: 0,
      is_correct: false,
      status: "timeout",
    }));

    await this.insertTimeoutRecords(sessionId, questionId, timeoutRecords);

    // Remettre les participants en état "waiting"
    const timedOutIds = timedOutParticipants.map((p) => p.id);
    await this.supabase
      .from("participants")
      .update({ status: "waiting" })
      .in("id", timedOutIds);
  }

  /**
   * Insère les lignes "timeout" sans échouer sur une réponse arrivée entre la
   * lecture des réponses et l'insertion (course réponse/timeout) : upsert
   * qui ignore les doublons sur l'index unique (participant_id, question_id)
   * de la migration 006. Si l'index est absent (base avec doublons
   * historiques, voir la migration), repli sur une insertion simple.
   * N'interrompt jamais la clôture : une erreur est journalisée.
   */
  private async insertTimeoutRecords(
    sessionId: string,
    questionId: string,
    records: Record<string, unknown>[],
  ): Promise<void> {
    let { error } = await this.supabase
      .from("participant_answers")
      .upsert(records, {
        onConflict: "participant_id,question_id",
        ignoreDuplicates: true,
      });

    // 42P10 : aucune contrainte unique ne correspond à ON CONFLICT
    if (error?.code === "42P10") {
      ({ error } = await this.supabase
        .from("participant_answers")
        .insert(records));
    }

    if (error) {
      this.logger.error(
        `Timeouts non enregistrés (session ${sessionId}, question ${questionId}): ${error.message}`,
      );
    }
  }

  /**
   * Nombre de participants actifs (ni "disconnected" ni "kicked") et nombre
   * d'entre eux ayant déjà répondu à la question. Sert à clôturer la question
   * dès que tout le monde a répondu.
   */
  async countActiveAnswers(
    sessionId: string,
    questionId: string,
  ): Promise<{ answeredCount: number; totalParticipants: number }> {
    const { data: participants } = await this.supabase
      .from("participants")
      .select("id")
      .eq("session_id", sessionId)
      .neq("status", "disconnected")
      .neq("status", "kicked");

    const { data: answers } = await this.supabase
      .from("participant_answers")
      .select("participant_id")
      .eq("session_id", sessionId)
      .eq("question_id", questionId);

    const activeIds = new Set((participants || []).map((p) => p.id));
    const answeredIds = new Set(
      (answers || [])
        .map((a) => a.participant_id)
        .filter((id) => activeIds.has(id)),
    );

    return {
      answeredCount: answeredIds.size,
      totalParticipants: activeIds.size,
    };
  }

  /**
   * Statistiques de fin de question (issue #6), calculées depuis
   * `participant_answers`. Seuls les participants actifs comptent : les
   * réponses d'un participant "kicked" ou "disconnected" sont ignorées.
   * Les lignes "timeout" (réponse vide) ne sont pas des réponses.
   */
  async computeQuestionStats(
    sessionId: string,
    question: QuestionForStats,
  ): Promise<QuestionStats> {
    const { data: participants } = await this.supabase
      .from("participants")
      .select("id")
      .eq("session_id", sessionId)
      .neq("status", "disconnected")
      .neq("status", "kicked");

    const { data: rows } = await this.supabase
      .from("participant_answers")
      .select("participant_id, answers, is_correct, status")
      .eq("session_id", sessionId)
      .eq("question_id", question.id);

    const activeIds = new Set((participants || []).map((p) => p.id));
    const type = question.type ?? "single";
    const graded = isGradedQuestionType(type);

    const answersByParticipant = new Map<
      string,
      { answers: string[]; isCorrect: boolean }
    >();
    let correctCount = 0;

    for (const row of rows || []) {
      if (!activeIds.has(row.participant_id)) continue;
      if (answersByParticipant.has(row.participant_id)) continue;
      const answers: string[] = Array.isArray(row.answers) ? row.answers : [];
      if (row.status === "timeout" || answers.length === 0) continue;

      const isCorrect = graded && row.is_correct === true;
      answersByParticipant.set(row.participant_id, { answers, isCorrect });
      if (isCorrect) correctCount++;
    }

    const totalParticipants = activeIds.size;
    return {
      questionId: question.id,
      type,
      distribution: buildAnswerDistribution(
        type,
        question.options,
        [...answersByParticipant.values()].map((a) => a.answers),
      ),
      correctAnswers: question.correct_answers || [],
      accuracy:
        graded && totalParticipants > 0
          ? Math.round((correctCount / totalParticipants) * 100)
          : 0,
      graded,
      answeredCount: answersByParticipant.size,
      totalParticipants,
      answersByParticipant,
    };
  }

  /**
   * Construit le classement complet d'une session après une question.
   * AMÉLIORATION AUDIT #3: Avec gaps et podium
   */
  async buildSessionLeaderboard(sessionId: string, questionId: string) {
    const { data: participants } = await this.supabase
      .from("participants")
      .select("id, pseudo, score")
      .eq("session_id", sessionId)
      .neq("status", "disconnected")
      .neq("status", "kicked")
      .order("score", { ascending: false });

    if (!participants) return [];

    // Récupérer les réponses à cette question spécifique
    const { data: questionAnswers } = await this.supabase
      .from("participant_answers")
      .select("participant_id, points_earned, is_correct")
      .eq("question_id", questionId);

    const answerMap = new Map(
      questionAnswers?.map((a) => [
        a.participant_id,
        { points: a.points_earned, correct: a.is_correct },
      ]) || [],
    );

    return buildLeaderboard(
      participants.map((p) => ({
        id: p.id,
        pseudo: p.pseudo,
        score: p.score,
        last_points: answerMap.get(p.id)?.points || 0,
        answered_current: answerMap.has(p.id),
      })),
    );
  }

  /**
   * Score, bonnes réponses et précision de la classe pour le mode
   * « classement masqué » (issue #8).
   *
   * `classAccuracy` = bonnes réponses / réponses attendues, en pourcentage
   * entier 0-100, sur toutes les lignes `participant_answers` de la session
   * (une par participant présent à la clôture de chaque question jouée :
   * réponse donnée ou "timeout"). Les lignes des participants exclus
   * ("kicked") sont ignorées, ainsi que les questions non notées (poll,
   * issue #7). `correctCount` = nombre de lignes `is_correct` du participant.
   */
  async computeClassProgress(sessionId: string): Promise<{
    classAccuracy: number;
    participants: Map<string, { score: number; correctCount: number }>;
  }> {
    const { data: participants } = await this.supabase
      .from("participants")
      .select("id, score, status")
      .eq("session_id", sessionId);

    const kept = (participants || []).filter((p) => p.status !== "kicked");
    const keptIds = new Set(kept.map((p) => p.id));

    // Lecture paginée : la session peut dépasser 1000 réponses
    const rows = await fetchAllRows<{
      id: string;
      participant_id: string;
      is_correct: boolean | null;
      questions?: unknown;
    }>((from, to) =>
      this.supabase
        .from("participant_answers")
        .select("id, participant_id, is_correct, questions (type)")
        .eq("session_id", sessionId)
        .order("id", { ascending: true })
        .range(from, to),
    );

    const progress = computeClassProgress(
      rows.filter(
        (r) =>
          keptIds.has(r.participant_id) &&
          isGradedQuestionType(joinedQuestionType(r) ?? "single"),
      ),
    );

    return {
      classAccuracy: progress.classAccuracy,
      participants: new Map(
        kept.map((p) => [
          p.id,
          {
            score: p.score ?? 0,
            correctCount: progress.correctByParticipant.get(p.id) ?? 0,
          },
        ]),
      ),
    };
  }

  /**
   * Récupère le résumé d'un participant pour une session.
   */
  async getParticipantSummary(participantId: string, sessionId: string) {
    const { data: participant } = await this.supabase
      .from("participants")
      .select("id, pseudo, score, status")
      .eq("id", participantId)
      .eq("session_id", sessionId)
      .single();

    if (!participant) return null;

    const { data: answers } = await this.supabase
      .from("participant_answers")
      .select(
        "is_correct, points_earned, time_taken_ms, status, questions (type)",
      )
      .eq("participant_id", participantId);

    // Questions non notées (poll, issue #7) exclues de la précision
    const graded = (answers || []).filter((a) =>
      isGradedQuestionType(joinedQuestionType(a) ?? "single"),
    );
    const correctCount = graded.filter((a) => a.is_correct).length;

    return {
      ...participant,
      correct_count: correctCount,
      total_answers: answers?.length || 0,
      accuracy:
        graded.length > 0
          ? Math.round((correctCount / graded.length) * 100)
          : 0,
    };
  }

  private async incrementParticipantScore(
    participantId: string,
    points: number,
  ) {
    if (points === 0) return;

    const { data: participant } = await this.supabase
      .from("participants")
      .select("score")
      .eq("id", participantId)
      .single();

    if (!participant) return;

    await this.supabase
      .from("participants")
      .update({
        score: participant.score + points,
        status: "answered",
      })
      .eq("id", participantId);
  }
}
