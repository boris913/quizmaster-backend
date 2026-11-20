import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_CLIENT } from "../database/database.module";
import { CreateSessionDto, JoinSessionDto } from "./dto/session.dto";
import {
  generateSessionPassword,
  normalizeSessionCode,
} from "../common/utils/scoring.util";
import {
  NICKNAME_ERRORS,
  generateNicknameSuggestions,
  getNicknameError,
} from "../common/utils/nickname.util";
import {
  buildSessionResults,
  ResultsAnswerRow,
  ResultsParticipantRow,
  ResultsQuestionRow,
  SessionResults,
} from "./results/session-results";
import { buildResultsCsv, resultsCsvFilename } from "./results/results-csv";
import { fetchAllRows } from "./results/fetch-all-rows";

/** Nombre maximal de tirages pour obtenir un code de session unique. */
export const MAX_SESSION_CODE_ATTEMPTS = 10;

/**
 * Violation d'unicité Postgres (23505) portant sur le code de session
 * (contrainte `sessions_password_key`).
 */
function isSessionCodeConflict(error: {
  code?: string;
  message?: string;
  details?: string;
}): boolean {
  return (
    error.code === "23505" &&
    /password/i.test(`${error.message ?? ""} ${error.details ?? ""}`)
  );
}

@Injectable()
export class SessionService {
  constructor(@Inject(SUPABASE_CLIENT) private supabase: SupabaseClient) {}

  // ============================================================
  // CRÉATION & GESTION DE SESSION (CRÉATEUR)
  // ============================================================

  async createSession(creatorId: string, dto: CreateSessionDto) {
    // Vérifier que le quiz appartient au créateur
    const { data: quiz } = await this.supabase
      .from("quizzes")
      .select("id, creator_id, total_questions, title")
      .eq("id", dto.quiz_id)
      .single();

    // 404 aussi si le quiz appartient à un autre : ne pas révéler son existence
    if (!quiz || !creatorId || quiz.creator_id !== creatorId) {
      throw new NotFoundException("Quiz introuvable");
    }
    if (quiz.total_questions === 0) {
      throw new BadRequestException("Le quiz doit avoir au moins une question");
    }

    // `sessions.password` est UNIQUE sur toute la table (sessions terminées
    // comprises) : on tente l'insertion et on retire un code en cas de
    // collision, dans la limite de MAX_SESSION_CODE_ATTEMPTS.
    // Même type que l'ancien insert direct (client Supabase non typé).
    let session: any = null;
    for (let attempt = 0; attempt < MAX_SESSION_CODE_ATTEMPTS; attempt++) {
      const { data, error } = await this.supabase
        .from("sessions")
        .insert({
          quiz_id: dto.quiz_id,
          creator_id: creatorId,
          password: generateSessionPassword(),
          status: "waiting",
          current_question_index: -1,
          nickname_mode: dto.nicknameMode ?? "free",
        })
        .select()
        .single();

      if (!error) {
        session = data;
        break;
      }
      if (!isSessionCodeConflict(error)) {
        throw new Error(`Erreur création session: ${error.message}`);
      }
    }
    if (!session) {
      throw new ServiceUnavailableException(
        "Impossible de générer un code de session unique, veuillez réessayer.",
      );
    }

    return {
      ...session,
      quiz_title: quiz.title,
      total_questions: quiz.total_questions,
    };
  }

  async getSessionByCreator(sessionId: string, creatorId: string) {
    const session = await this.getSessionWithDetails(sessionId);

    // 404 plutôt que 403 : ne pas révéler l'existence de la session
    if (!creatorId || session.creator_id !== creatorId) {
      throw new NotFoundException("Session introuvable");
    }

    return session;
  }

  /**
   * Participants d'une session, réservé à son créateur (route HTTP).
   * `getSessionParticipants` reste l'accès interne (gateway), sans contrôle.
   */
  async getSessionParticipantsForCreator(sessionId: string, creatorId: string) {
    await this.assertCreatorSession(sessionId, creatorId);
    return this.getSessionParticipants(sessionId);
  }

  /**
   * Classement d'une session, réservé à son créateur (route HTTP).
   * `getSessionLeaderboard` reste l'accès interne (gateway), sans contrôle.
   */
  async getSessionLeaderboardForCreator(sessionId: string, creatorId: string) {
    await this.assertCreatorSession(sessionId, creatorId);
    return this.getSessionLeaderboard(sessionId);
  }

  async getCreatorSessions(creatorId: string) {
    const { data, error } = await this.supabase
      .from("sessions")
      .select(
        `
        id, password, status, current_question_index, created_at, started_at, ended_at,
        quizzes (id, title, total_questions)
      `,
      )
      .eq("creator_id", creatorId)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Erreur: ${error.message}`);
    return data || [];
  }

  async endSession(sessionId: string, creatorId: string) {
    await this.assertCreatorSession(sessionId, creatorId);

    const { data, error } = await this.supabase
      .from("sessions")
      .update({ status: "finished", ended_at: new Date().toISOString() })
      .eq("id", sessionId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  /**
   * Supprime définitivement une session et toutes ses données (RGPD, issue #9).
   * Réservé au créateur (404 sinon). Les participants et leurs réponses sont
   * supprimés par la base grâce aux clés étrangères `ON DELETE CASCADE`
   * (`participants.session_id`, `participant_answers.session_id` et
   * `participant_answers.participant_id`, voir migrations/000_initial_schema.sql).
   */
  async deleteSession(sessionId: string, creatorId: string) {
    await this.assertCreatorSession(sessionId, creatorId);

    const { error } = await this.supabase
      .from("sessions")
      .delete()
      .eq("id", sessionId)
      .eq("creator_id", creatorId);

    if (error) throw new Error(`Erreur suppression session: ${error.message}`);
    return { id: sessionId, deleted: true };
  }

  // ============================================================
  // REJOINDRE UNE SESSION (PARTICIPANT)
  // ============================================================

  async joinSession(dto: JoinSessionDto) {
    // Chercher la session par mot de passe
    const { data: session, error: sessionError } = await this.supabase
      .from("sessions")
      .select("id, status, quiz_id, quizzes(title, total_questions)")
      .eq("password", normalizeSessionCode(dto.password))
      .in("status", ["waiting", "active", "paused"])
      .single();

    if (sessionError || !session) {
      throw new NotFoundException(
        "Session introuvable ou terminée. Vérifiez le mot de passe.",
      );
    }

    await this.assertNicknameAcceptable(session.id, dto.pseudo);

    // Vérifier unicité du pseudo dans cette session
    const { data: existingParticipant } = await this.supabase
      .from("participants")
      .select("id, status")
      .eq("session_id", session.id)
      .eq("pseudo", dto.pseudo)
      .single();

    if (existingParticipant && existingParticipant.status !== "disconnected") {
      throw new ConflictException(
        "Ce pseudo est déjà utilisé dans cette session",
      );
    }

    // Si le participant existait (déconnecté), le réactiver
    if (existingParticipant) {
      const { data: updated } = await this.supabase
        .from("participants")
        .update({ status: "waiting" })
        .eq("id", existingParticipant.id)
        .select()
        .single();
      return { participant: updated, session };
    }

    // Créer un nouveau participant
    const { data: participant, error: partError } = await this.supabase
      .from("participants")
      .insert({
        session_id: session.id,
        pseudo: dto.pseudo,
        score: 0,
        status: "waiting",
      })
      .select()
      .single();

    if (partError) throw new Error(`Erreur: ${partError.message}`);

    return { participant, session };
  }

  // ============================================================
  // MODÉRATION DES PSEUDOS (issue #5)
  // ============================================================

  /**
   * Refuse un pseudo interdit (mode "free"), non issu du générateur (mode
   * "generated") ou déjà exclu de cette session par le créateur.
   */
  async assertNicknameAcceptable(sessionId: string, pseudo: string) {
    const { data: session } = await this.supabase
      .from("sessions")
      .select("nickname_mode")
      .eq("id", sessionId)
      .single();

    const error = getNicknameError(pseudo, session?.nickname_mode);
    if (error) throw new BadRequestException(error);

    const { data: kicked } = await this.supabase
      .from("participants")
      .select("id")
      .eq("session_id", sessionId)
      .eq("status", "kicked")
      .ilike("pseudo", escapeLikePattern(pseudo))
      .limit(1);

    if (kicked && kicked.length > 0) {
      throw new ForbiddenException(NICKNAME_ERRORS.kicked);
    }
  }

  /**
   * Trois propositions de pseudo pour une session joignable, sans les pseudos
   * déjà pris. Route publique : ne renvoie que le mode et les propositions.
   */
  async getNicknameSuggestions(code: string) {
    const { data: session } = await this.supabase
      .from("sessions")
      .select("id, nickname_mode")
      .eq("password", normalizeSessionCode(code ?? ""))
      .in("status", ["waiting", "active", "paused"])
      .single();

    if (!session) {
      throw new NotFoundException(
        "Session introuvable ou terminée. Vérifiez le mot de passe.",
      );
    }

    const { data: participants } = await this.supabase
      .from("participants")
      .select("pseudo")
      .eq("session_id", session.id);

    return {
      nickname_mode: session.nickname_mode ?? "free",
      suggestions: generateNicknameSuggestions(
        3,
        (participants || []).map((p) => p.pseudo),
      ),
    };
  }

  /**
   * Contrôle d'un "participant:join" WebSocket : le participant doit exister
   * dans cette session, ne pas être exclu, et son pseudo doit respecter le
   * mode de la session.
   */
  async assertParticipantCanJoin(sessionId: string, participantId: string) {
    const participant = await this.getParticipant(participantId);

    if (participant.session_id !== sessionId) {
      throw new ForbiddenException("Participant non trouvé dans cette session");
    }
    if (participant.status === "kicked") {
      throw new ForbiddenException(NICKNAME_ERRORS.kicked);
    }

    const session = await this.getSessionWithDetails(sessionId);
    const error = getNicknameError(participant.pseudo, session.nickname_mode);
    if (error) throw new BadRequestException(error);

    return participant;
  }

  /**
   * Exclut un participant de la session (statut "kicked"). Le contrôle de
   * propriété est fait par l'appelant (gateway). Renvoie le participant tel
   * qu'il était avant l'exclusion.
   */
  async kickParticipant(sessionId: string, participantId: string) {
    const participant = await this.getParticipant(participantId);

    if (participant.session_id !== sessionId) {
      throw new NotFoundException("Participant introuvable dans cette session");
    }

    const { error } = await this.supabase
      .from("participants")
      .update({ status: "kicked", socket_id: null })
      .eq("id", participantId);

    if (error) throw new Error(error.message);
    return participant;
  }

  // ============================================================
  // AMÉLIORATION AUDIT #6: RECONNEXION D'UN PARTICIPANT
  // ============================================================

  async getParticipant(participantId: string) {
    const { data: participant, error } = await this.supabase
      .from("participants")
      .select("id, session_id, pseudo, score, status, joined_at")
      .eq("id", participantId)
      .single();

    if (error || !participant) {
      throw new NotFoundException("Participant introuvable");
    }

    return participant;
  }

  async reconnectParticipant(sessionId: string, participantId: string) {
    const participant = await this.getParticipant(participantId);

    if (participant.session_id !== sessionId) {
      throw new ForbiddenException("Participant non trouvé dans cette session");
    }

    if (participant.status === "kicked") {
      throw new ForbiddenException(NICKNAME_ERRORS.kicked);
    }

    // Réactiver le participant s'il était déconnecté
    if (participant.status === "disconnected") {
      await this.supabase
        .from("participants")
        .update({ status: "waiting" })
        .eq("id", participantId);
    }

    const session = await this.getSessionWithDetails(sessionId);

    return { participant, session };
  }

  // ============================================================
  // ACCÈS AUX DONNÉES DE SESSION
  // ============================================================

  async getSessionWithDetails(sessionId: string) {
    const { data: session, error } = await this.supabase
      .from("sessions")
      .select(
        `
        *,
        quizzes (id, title, description, total_questions, global_timer_seconds, use_global_timer)
      `,
      )
      .eq("id", sessionId)
      .single();

    if (error || !session) throw new NotFoundException("Session introuvable");
    return session;
  }

  async getSessionParticipants(sessionId: string) {
    const { data, error } = await this.supabase
      .from("participants")
      .select("id, pseudo, score, status, joined_at")
      .eq("session_id", sessionId)
      .neq("status", "disconnected")
      .neq("status", "kicked")
      .order("score", { ascending: false });

    if (error) throw new Error(error.message);
    return data || [];
  }

  async getSessionLeaderboard(sessionId: string) {
    const participants = await this.getSessionParticipants(sessionId);
    return participants.map((p, index) => ({
      rank: index + 1,
      participant_id: p.id,
      pseudo: p.pseudo,
      score: p.score,
      last_points: 0,
      answered_current: false,
      gap_to_next: null,
      gap_to_podium: null,
      on_podium: index < 3,
    }));
  }

  /**
   * Résultats enrichis d'une session, réservés à son créateur (404 sinon).
   * Contrat : voir `SessionResults` (issue #4).
   */
  async getSessionResults(
    sessionId: string,
    creatorId: string,
  ): Promise<SessionResults> {
    const { results } = await this.loadSessionResults(sessionId, creatorId);
    return results;
  }

  /** Export CSV des résultats (`;`, UTF-8 avec BOM), réservé au créateur. */
  async getSessionResultsCsv(
    sessionId: string,
    creatorId: string,
  ): Promise<{ filename: string; csv: string }> {
    const { results, answers } = await this.loadSessionResults(
      sessionId,
      creatorId,
    );
    return {
      filename: resultsCsvFilename(results),
      csv: buildResultsCsv(results, answers),
    };
  }

  private async loadSessionResults(sessionId: string, creatorId: string) {
    // Contrôle de propriété avant toute autre lecture
    const session = await this.getSessionByCreator(sessionId, creatorId);

    const [questionsRes, participants, answers] = await Promise.all([
      this.supabase
        .from("questions")
        .select("id, order_index, text, type, options, correct_answers")
        .eq("quiz_id", session.quiz_id)
        .order("order_index", { ascending: true }),
      // Tous les participants, y compris déconnectés : ils ont joué.
      // Lecture paginée (ordre stable : score puis id).
      fetchAllRows<ResultsParticipantRow>((from, to) =>
        this.supabase
          .from("participants")
          .select("id, pseudo, score")
          .eq("session_id", sessionId)
          .order("score", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      // Lecture paginée : une classe dépasse vite la limite de 1000 lignes
      fetchAllRows<ResultsAnswerRow>((from, to) =>
        this.supabase
          .from("participant_answers")
          .select(
            "participant_id, question_id, answers, status, is_correct, time_taken_ms",
          )
          .eq("session_id", sessionId)
          .order("id", { ascending: true })
          .range(from, to),
      ),
    ]).catch((err: Error) => {
      throw new Error(`Erreur lecture résultats: ${err.message}`);
    });

    if (questionsRes.error) {
      throw new Error(
        `Erreur lecture résultats: ${questionsRes.error.message}`,
      );
    }

    const results = buildSessionResults({
      session,
      questions: (questionsRes.data ?? []) as ResultsQuestionRow[],
      participants,
      answers,
    });

    return { results, answers };
  }

  // ============================================================
  // HELPERS
  // ============================================================

  /**
   * Vérifie que la session appartient à `creatorId`. Renvoie 404 dans les deux
   * cas (inexistante ou appartenant à un autre) pour ne pas révéler son
   * existence.
   */
  async assertCreatorSession(sessionId: string, creatorId: string) {
    const { data: session } = await this.supabase
      .from("sessions")
      .select("creator_id")
      .eq("id", sessionId)
      .single();

    if (!session || !creatorId || session.creator_id !== creatorId) {
      throw new NotFoundException("Session introuvable");
    }

    return session;
  }

  async updateSessionStatus(
    sessionId: string,
    status: "waiting" | "active" | "paused" | "finished",
  ) {
    const updates: any = { status };
    if (status === "active") updates.started_at = new Date().toISOString();
    if (status === "finished") updates.ended_at = new Date().toISOString();

    const { data, error } = await this.supabase
      .from("sessions")
      .update(updates)
      .eq("id", sessionId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  async setCurrentQuestion(
    sessionId: string,
    questionIndex: number,
    startedAt: Date = new Date(),
  ) {
    const { data, error } = await this.supabase
      .from("sessions")
      .update({
        current_question_index: questionIndex,
        question_start_time: startedAt.toISOString(),
        status: "active",
      })
      .eq("id", sessionId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  async updateParticipantSocketId(participantId: string, socketId: string) {
    await this.supabase
      .from("participants")
      .update({ socket_id: socketId })
      .eq("id", participantId);
  }

  async updateParticipantStatus(participantId: string, status: string) {
    await this.supabase
      .from("participants")
      .update({ status })
      .eq("id", participantId);
  }

  async updateParticipantScore(
    participantId: string,
    additionalPoints: number,
  ) {
    const { data: participant } = await this.supabase
      .from("participants")
      .select("score")
      .eq("id", participantId)
      .single();

    if (!participant) return;

    await this.supabase
      .from("participants")
      .update({
        score: participant.score + additionalPoints,
        status: "answered",
      })
      .eq("id", participantId);
  }
}

/** Échappe `%`, `_` et `\` pour une comparaison ILIKE littérale. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
