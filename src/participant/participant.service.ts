import { Injectable, Inject, BadRequestException } from "@nestjs/common";
import { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_CLIENT } from "../database/database.module";
import {
  calculatePoints,
  checkAnswer,
  buildLeaderboard,
} from "../common/utils/scoring.util";

export interface SubmitAnswerParams {
  participantId: string;
  sessionId: string;
  questionId: string;
  answers: string[];
  timeTakenMs: number;
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

@Injectable()
export class ParticipantService {
  constructor(@Inject(SUPABASE_CLIENT) private supabase: SupabaseClient) {}

  /**
   * Enregistre la réponse d'un participant et calcule les points.
   * AMÉLIORATION AUDIT #7: Tolérance réseau de 2 secondes
   */
  async submitAnswer(params: SubmitAnswerParams): Promise<AnswerResult> {
    const { participantId, sessionId, questionId, answers, timeTakenMs } =
      params;

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

    // Vérifier si la réponse est correcte
    const isCorrect = checkAnswer(
      answers,
      question.correct_answers,
      question.type,
    );

    // AMÉLIORATION AUDIT #7: Calculer le vrai temps côté serveur avec tolérance
    const { data: session } = await this.supabase
      .from("sessions")
      .select("question_start_time")
      .eq("id", sessionId)
      .single();

    const serverTimeTaken =
      Date.now() -
      new Date(session?.question_start_time || Date.now()).getTime();
    const timerMs = question.timer_seconds * 1000;

    // Tolérance de 2 secondes pour le réseau
    const validTimeTaken = Math.min(
      Math.max(timeTakenMs, serverTimeTaken - 2000),
      timerMs,
    );

    // Calculer les points avec le temps validé
    const pointsEarned = calculatePoints(
      isCorrect,
      validTimeTaken,
      question.timer_seconds,
      question.max_points,
    );

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
      .neq("status", "disconnected");

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

    await this.supabase.from("participant_answers").insert(timeoutRecords);

    // Remettre les participants en état "waiting"
    const timedOutIds = timedOutParticipants.map((p) => p.id);
    await this.supabase
      .from("participants")
      .update({ status: "waiting" })
      .in("id", timedOutIds);
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
      .select("is_correct, points_earned, time_taken_ms, status")
      .eq("participant_id", participantId);

    const correctCount = answers?.filter((a) => a.is_correct).length || 0;
    const totalAnswers = answers?.length || 0;

    return {
      ...participant,
      correct_count: correctCount,
      total_answers: totalAnswers,
      accuracy:
        totalAnswers > 0 ? Math.round((correctCount / totalAnswers) * 100) : 0,
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
