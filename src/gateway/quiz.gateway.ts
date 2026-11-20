import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
  WsException,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Inject, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_CLIENT } from "../database/database.module";
import {
  ASYNC_LIVE_FORBIDDEN,
  SessionService,
} from "../session/session.service";
import {
  ANSWER_ALREADY_RECORDED,
  ParticipantService,
} from "../participant/participant.service";
import { corsOriginCallback } from "../common/utils/cors.util";
import { NICKNAME_ERRORS } from "../common/utils/nickname.util";
import type {
  WsHiddenQuizFinishedPayload,
  WsPlayerScorePayload,
  WsQuestionRevealPayload,
  WsQuestionStatsPayload,
} from "../common/types";

// ============================================================
// Payloads entrants (client → serveur)
// ============================================================
interface WsJoinSessionPayload {
  sessionId: string;
  participantId: string;
  role: "creator" | "participant";
}

interface WsCreatorJoinPayload {
  sessionId: string;
  token: string; // JWT du créateur
}

interface WsStartQuestionPayload {
  sessionId: string;
  questionIndex: number;
}

interface WsSubmitAnswerPayload {
  sessionId: string;
  participantId: string;
  questionId: string;
  answers: string[];
  /** Ignoré : le temps de réponse est calculé côté serveur. */
  timeTakenMs?: number;
}

interface WsEndQuizPayload {
  sessionId: string;
}

interface WsCreatorKickPayload {
  sessionId: string;
  participantId: string;
}

// Map interne: sessionId → { timerId, questionStartTime }
// Les champs correctAnswers / explanation restent côté serveur jusqu'à la
// clôture de la question (anti-triche, issue #6).
interface ActiveQuestionState {
  timerId: NodeJS.Timeout;
  questionId: string;
  timerSeconds: number;
  questionStartTime: number;
  useGlobalTimer: boolean; // AMÉLIORATION AUDIT #4
  options: Array<{ id: string; text: string }>;
  correctAnswers: string[];
  explanation: string | null;
  /** Faux si la session masque le classement aux joueurs (issue #8). */
  showLeaderboard: boolean;
}

/** Cause de la clôture d'une question. */
type QuestionCloseReason = "timeout" | "all_answered";

@WebSocketGateway({
  cors: {
    // Lu à chaque connexion (CORS_ORIGINS), voir common/utils/cors.util.ts
    origin: corsOriginCallback,
    credentials: true,
  },
  namespace: "/",
})
export class QuizGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(QuizGateway.name);

  // Map des questions actives : sessionId → state
  private activeQuestions = new Map<string, ActiveQuestionState>();

  // Map socket → { participantId, sessionId, role }
  private socketMeta = new Map<
    string,
    {
      participantId?: string;
      sessionId?: string;
      role: "creator" | "participant";
    }
  >();

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private sessionService: SessionService,
    private participantService: ParticipantService,
    @Inject(SUPABASE_CLIENT) private supabase: SupabaseClient,
  ) {}

  // ============================================================
  // CONNEXION / DÉCONNEXION
  // ============================================================

  async handleConnection(client: Socket) {
    this.logger.log(`Socket connecté: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Socket déconnecté: ${client.id}`);

    const meta = this.socketMeta.get(client.id);
    if (meta?.participantId && meta.role === "participant") {
      // Marquer le participant comme déconnecté
      await this.supabase
        .from("participants")
        .update({ status: "disconnected", socket_id: null })
        .eq("id", meta.participantId)
        .neq("status", "kicked");

      if (meta.sessionId) {
        // Notifier le créateur
        this.server
          .to(`creator:${meta.sessionId}`)
          .emit("participant:disconnected", {
            participant_id: meta.participantId,
          });
      }
    }

    this.socketMeta.delete(client.id);

    // Le joueur parti était peut-être le dernier à ne pas avoir répondu
    if (meta?.participantId && meta.role === "participant" && meta.sessionId) {
      await this.closeQuestionIfAllAnswered(meta.sessionId);
    }
  }

  // ============================================================
  // ÉVÉNEMENTS PARTICIPANT
  // ============================================================

  /**
   * Événement: "participant:join"
   * Un participant rejoint la salle de la session.
   */
  @SubscribeMessage("participant:join")
  async handleParticipantJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WsJoinSessionPayload,
  ) {
    try {
      const { sessionId, participantId } = payload;

      // Participant de cette session, non exclu, pseudo conforme au mode
      await this.sessionService.assertParticipantCanJoin(
        sessionId,
        participantId,
      );

      // Rejoindre la room socket de la session
      await client.join(`session:${sessionId}`);

      // Mémoriser les métadonnées du socket
      this.socketMeta.set(client.id, {
        participantId,
        sessionId,
        role: "participant",
      });

      // Mettre à jour le socket_id du participant en BDD
      await this.supabase
        .from("participants")
        .update({ socket_id: client.id, status: "waiting" })
        .eq("id", participantId);

      // Récupérer les infos du participant
      const { data: participant } = await this.supabase
        .from("participants")
        .select("id, pseudo, score, status")
        .eq("id", participantId)
        .single();

      // Compter les participants
      const { count } = await this.supabase
        .from("participants")
        .select("id", { count: "exact", head: true })
        .eq("session_id", sessionId)
        .neq("status", "disconnected")
        .neq("status", "kicked");

      // Notifier TOUT le monde dans la session (y compris créateur)
      const joinedPayload = { participant, total_participants: count || 0 };
      if (await this.isLeaderboardHidden(sessionId)) {
        // Classement masqué (issue #8) : pas de score des autres joueurs
        this.server
          .to(`creator:${sessionId}`)
          .emit("participant:joined", joinedPayload);
        const publicParticipant = participant
          ? {
              id: participant.id,
              pseudo: participant.pseudo,
              status: participant.status,
            }
          : participant;
        await this.forEachPlayerSocket(sessionId, (socket) =>
          socket.emit("participant:joined", {
            participant: publicParticipant,
            total_participants: count || 0,
          }),
        );
      } else {
        this.server
          .to(`session:${sessionId}`)
          .emit("participant:joined", joinedPayload);
      }

      // Si une question est en cours, envoyer l'état actuel
      const activeQ = this.activeQuestions.get(sessionId);
      if (activeQ) {
        const elapsed = Date.now() - activeQ.questionStartTime;
        const remaining = Math.max(0, activeQ.timerSeconds * 1000 - elapsed);
        client.emit("question:in_progress", {
          question_id: activeQ.questionId,
          time_remaining_ms: remaining,
        });
      }

      client.emit("participant:join:success", {
        participant,
        session_id: sessionId,
      });
    } catch (error) {
      this.logger.error(`Erreur participant:join: ${error.message}`);
      if (error.message === NICKNAME_ERRORS.kicked) {
        client.emit("participant:kicked", { reason: "kicked" });
        client.disconnect(true);
        return;
      }
      client.emit(
        "error",
        error.message === ASYNC_LIVE_FORBIDDEN
          ? { message: error.message, mode: "async" }
          : { message: error.message },
      );
    }
  }

  // ============================================================
  // ÉVÉNEMENTS CRÉATEUR
  // ============================================================

  /**
   * Événement: "creator:join"
   * Le créateur rejoint le panneau de contrôle de la session.
   * Authentifié via JWT.
   */
  @SubscribeMessage("creator:join")
  async handleCreatorJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WsCreatorJoinPayload,
  ) {
    try {
      // Vérifier le JWT
      const decoded = await this.jwtService.verifyAsync(payload.token, {
        secret: this.configService.get<string>("JWT_SECRET"),
      });

      const { sessionId } = payload;

      // Vérifier que le créateur est bien propriétaire de la session
      const { data: session } = await this.supabase
        .from("sessions")
        .select("creator_id, status, mode")
        .eq("id", sessionId)
        .single();

      if (!session || session.creator_id !== decoded.sub) {
        throw new WsException("Accès refusé");
      }

      // Un devoir (issue #10) ne se pilote pas en direct : sans "creator:join",
      // aucun événement de pilotage (question:start, quiz:end…) n'est accepté.
      if (session.mode === "async") {
        client.emit("error", { message: ASYNC_LIVE_FORBIDDEN, mode: "async" });
        return;
      }

      // Rejoindre la room créateur ET la room de la session
      await client.join(`creator:${sessionId}`);
      await client.join(`session:${sessionId}`);

      this.socketMeta.set(client.id, { sessionId, role: "creator" });

      // Envoyer l'état actuel de la session
      const participants =
        await this.sessionService.getSessionParticipants(sessionId);
      const leaderboard =
        await this.sessionService.getSessionLeaderboard(sessionId);

      client.emit("creator:join:success", {
        session_id: sessionId,
        status: session.status,
        participants,
        leaderboard,
      });

      this.logger.log(
        `Créateur ${decoded.pseudo} a rejoint la session ${sessionId}`,
      );
    } catch (error) {
      this.logger.error(`Erreur creator:join: ${error.message}`);
      client.emit("error", { message: "Authentification échouée" });
    }
  }

  /**
   * Événement: "question:start"
   * Le créateur lance une question.
   * AMÉLIORATION AUDIT #1: Countdown 3-2-1-GO avant la question
   */
  @SubscribeMessage("question:start")
  async handleStartQuestion(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WsStartQuestionPayload,
  ) {
    try {
      const { sessionId, questionIndex } = payload;

      // Vérifier que ce socket est le créateur authentifié de CETTE session
      if (!this.isCreatorOfSession(client, sessionId)) {
        throw new WsException("Seul le créateur peut lancer une question");
      }

      // Annuler tout timer précédent
      const existingQ = this.activeQuestions.get(sessionId);
      if (existingQ) {
        clearTimeout(existingQ.timerId);
        this.activeQuestions.delete(sessionId);
      }

      // Récupérer la session et la question
      const sessionDetails =
        await this.sessionService.getSessionWithDetails(sessionId);
      // Défense en profondeur : un devoir ne se pilote pas en direct (#10)
      if (sessionDetails.mode === "async") {
        throw new WsException(ASYNC_LIVE_FORBIDDEN);
      }
      const quiz = sessionDetails.quizzes;

      const { data: questions } = await this.supabase
        .from("questions")
        .select("*")
        .eq("quiz_id", quiz.id)
        .order("order_index", { ascending: true });

      if (!questions || questionIndex >= questions.length) {
        throw new WsException("Question introuvable");
      }

      const question = questions[questionIndex];
      const timerSeconds = quiz.use_global_timer
        ? quiz.global_timer_seconds
        : question.timer_seconds;

      // Remettre TOUS les participants en état "answering"
      await this.supabase
        .from("participants")
        .update({ status: "answering" })
        .eq("session_id", sessionId)
        .neq("status", "disconnected")
        .neq("status", "kicked");

      // Préparer la question SANS les réponses correctes NI l'explication
      // (liste blanche : ne jamais diffuser `question` tel quel aux joueurs)
      const sanitizedQuestion = {
        id: question.id,
        text: question.text,
        type: question.type,
        options: question.options,
        max_points: question.max_points,
        timer_seconds: timerSeconds,
        order_index: question.order_index,
      };

      // ============================================================
      // AMÉLIORATION AUDIT #1: ANIMATION COUNTDOWN 3-2-1-GO
      // ============================================================
      await this.sendCountdown(sessionId, 3);

      const questionStartTime = Date.now();

      // Mettre à jour la session en BDD. question_start_time est la référence
      // du calcul du temps de réponse côté serveur : elle est fixée à la fin
      // du compte à rebours, au moment où la question est diffusée.
      await this.sessionService.setCurrentQuestion(
        sessionId,
        questionIndex,
        new Date(questionStartTime),
      );

      // Broadcast à TOUS les participants
      this.server.to(`session:${sessionId}`).emit("question:start", {
        question: sanitizedQuestion,
        question_number: questionIndex + 1,
        total_questions: questions.length,
        timer_seconds: timerSeconds,
        started_at: questionStartTime,
      });

      // Démarrer le timer côté serveur (source de vérité)
      const timerId = setTimeout(() => {
        void this.closeQuestion(sessionId, question.id, "timeout");
      }, timerSeconds * 1000);

      // AMÉLIORATION AUDIT #4: Stocker useGlobalTimer
      this.activeQuestions.set(sessionId, {
        timerId,
        questionId: question.id,
        timerSeconds,
        questionStartTime,
        useGlobalTimer: quiz.use_global_timer,
        options: Array.isArray(question.options) ? question.options : [],
        correctAnswers: question.correct_answers || [],
        explanation: question.explanation ?? null,
        showLeaderboard: sessionDetails.show_leaderboard !== false,
      });

      this.logger.log(
        `Question ${questionIndex + 1}/${questions.length} lancée dans session ${sessionId} (${timerSeconds}s)`,
      );
    } catch (error) {
      this.logger.error(`Erreur question:start: ${error.message}`);
      client.emit(
        "error",
        error.message === ASYNC_LIVE_FORBIDDEN
          ? { message: error.message, mode: "async" }
          : { message: error.message },
      );
    }
  }

  /**
   * AMÉLIORATION AUDIT #1: Countdown 3-2-1-GO
   */
  private async sendCountdown(
    sessionId: string,
    seconds: number,
  ): Promise<void> {
    const messages = ["Prêt ?", "Steady...", "GO !"];

    for (let i = seconds; i > 0; i--) {
      const messageIndex = seconds - i;
      this.server.to(`session:${sessionId}`).emit("question:countdown", {
        countdown: i,
        message: messages[messageIndex] || "GO !",
      });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /**
   * Événement: "answer:submit"
   * Un participant soumet sa réponse.
   * AMÉLIORATION AUDIT #5: Progression par participant
   * AMÉLIORATION AUDIT #7: Tolérance réseau
   */
  @SubscribeMessage("answer:submit")
  async handleSubmitAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WsSubmitAnswerPayload,
  ) {
    // Heure de réception côté serveur : seule base du temps de réponse
    const receivedAtMs = Date.now();
    try {
      const { sessionId, participantId, questionId, answers } = payload;

      // Vérifier que la question est toujours active
      const activeQ = this.activeQuestions.get(sessionId);
      if (!activeQ || activeQ.questionId !== questionId) {
        client.emit("answer:too_late", {
          message: "Le temps est écoulé pour cette question",
        });
        return;
      }

      // Enregistrer la réponse et calculer les points (avec tolérance réseau)
      const result = await this.participantService.submitAnswer({
        participantId,
        sessionId,
        questionId,
        answers,
        receivedAtMs,
      });

      // Mettre à jour le statut du participant
      await this.supabase
        .from("participants")
        .update({ status: "answered" })
        .eq("id", participantId);

      // Envoyer le résultat UNIQUEMENT au participant (avec gaps).
      // Anti-triche (issue #6) : la bonne réponse n'est jamais envoyée avant
      // la clôture de la question ; elle part dans "question:reveal".
      const answerResult = {
        is_correct: result.isCorrect,
        points_earned: result.pointsEarned,
        max_points: questionId, // sera remplacé par le vrai max_points
        time_taken_ms: result.timeTakenMs,
        correct_answers: [],
        your_answer: answers,
        total_score: result.totalScore,
        rank: result.rank,
        total_participants: 0, // sera calculé
        gap_to_next: result.gapToNext,
        gap_to_podium: result.gapToPodium,
        on_podium: result.onPodium,
        waiting_for_timer: true,
      };
      if (activeQ.showLeaderboard) {
        client.emit("answer:result", answerResult);
      } else {
        // Classement masqué (issue #8) : ni rang, ni écarts, ni podium
        client.emit("answer:result", {
          is_correct: answerResult.is_correct,
          points_earned: answerResult.points_earned,
          max_points: answerResult.max_points,
          time_taken_ms: answerResult.time_taken_ms,
          correct_answers: answerResult.correct_answers,
          your_answer: answerResult.your_answer,
          total_score: answerResult.total_score,
          waiting_for_timer: answerResult.waiting_for_timer,
        });
      }

      // ============================================================
      // AMÉLIORATION AUDIT #5: BARRE DE PROGRESSION PARTICIPANT
      // ============================================================
      const { data: quizData } = await this.supabase
        .from("quizzes")
        .select("total_questions")
        .eq(
          "id",
          (await this.sessionService.getSessionWithDetails(sessionId)).quiz_id,
        )
        .single();

      const { count } = await this.supabase
        .from("participant_answers")
        .select("id", { count: "exact", head: true })
        .eq("session_id", sessionId)
        .eq("question_id", questionId);

      const { count: totalCount } = await this.supabase
        .from("participants")
        .select("id", { count: "exact", head: true })
        .eq("session_id", sessionId)
        .neq("status", "disconnected")
        .neq("status", "kicked");

      // Récupérer le pseudo du participant
      const { data: participant } = await this.supabase
        .from("participants")
        .select("pseudo")
        .eq("id", participantId)
        .single();

      const progress = {
        participant_id: participantId,
        pseudo: participant?.pseudo || "",
        answered_count: count || 0,
        total_count: totalCount || 0,
        questions_answered: count || 0,
        total_questions: quizData?.total_questions || 0,
        progress_percentage: quizData
          ? Math.round((count / quizData.total_questions) * 100)
          : 0,
      };

      this.server
        .to(`creator:${sessionId}`)
        .emit("participant:answered", progress);

      this.logger.log(
        `Réponse: participant ${participantId}, correct=${result.isCorrect}, points=${result.pointsEarned}`,
      );

      // Tous les participants actifs ont répondu : clôture anticipée
      await this.closeQuestionIfAllAnswered(sessionId);
    } catch (error) {
      // Course réponse/timeout : le timeout de la clôture est déjà enregistré
      if (error.message === ANSWER_ALREADY_RECORDED) {
        client.emit("answer:too_late", {
          message: "Le temps est écoulé pour cette question",
        });
        return;
      }
      this.logger.error(`Erreur answer:submit: ${error.message}`);
      client.emit("error", { message: error.message });
    }
  }

  /**
   * Événement: "quiz:end"
   * Le créateur termine le quiz.
   * AMÉLIORATION AUDIT #2: Messages personnalisés par participant
   */
  @SubscribeMessage("quiz:end")
  async handleEndQuiz(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WsEndQuizPayload,
  ) {
    try {
      const { sessionId } = payload;

      if (!this.isCreatorOfSession(client, sessionId)) {
        throw new WsException("Seul le créateur peut terminer le quiz");
      }

      // Annuler le timer actif
      const activeQ = this.activeQuestions.get(sessionId);
      if (activeQ) {
        clearTimeout(activeQ.timerId);
        this.activeQuestions.delete(sessionId);
      }

      // Mettre à jour la session
      await this.sessionService.updateSessionStatus(sessionId, "finished");

      // Construire le classement final
      const { data: finalParticipants } = await this.supabase
        .from("participants")
        .select("id, pseudo, score")
        .eq("session_id", sessionId)
        .neq("status", "disconnected")
        .neq("status", "kicked")
        .order("score", { ascending: false });

      const finalLeaderboard = (finalParticipants || []).map((p, i) => ({
        rank: i + 1,
        participant_id: p.id,
        pseudo: p.pseudo,
        score: p.score,
        gap_to_next:
          i > 0 ? (finalParticipants[i - 1]?.score ?? 0) - p.score : null,
        gap_to_podium:
          i >= 3 ? (finalParticipants[2]?.score ?? 0) - p.score : null,
        on_podium: i < 3,
      }));

      const winner = finalLeaderboard[0];
      const creatorFinished = {
        final_leaderboard: finalLeaderboard.slice(0, 10),
        winner_pseudo: winner?.pseudo || null,
        total_participants: finalLeaderboard.length,
        total_questions: finalParticipants?.length || 0,
      };

      // Classement masqué (issue #8) : chaque joueur ne reçoit que la
      // précision de la classe et son propre score ; le créateur, tout
      if (await this.isLeaderboardHidden(sessionId)) {
        const progress =
          await this.participantService.computeClassProgress(sessionId);
        await this.forEachPlayerSocket(sessionId, (socket, participantId) => {
          const payload: WsHiddenQuizFinishedPayload = {
            classAccuracy: progress.classAccuracy,
            yourScore: progress.participants.get(participantId)?.score ?? 0,
          };
          socket.emit("quiz:finished", payload);
        });
        this.server
          .to(`creator:${sessionId}`)
          .emit("quiz:finished", creatorFinished);
        this.logger.log(
          `Quiz terminé pour la session ${sessionId} (classement masqué)`,
        );
        return;
      }

      // ============================================================
      // AMÉLIORATION AUDIT #2: MESSAGE PERSONNALISÉ PAR PARTICIPANT
      // ============================================================
      const sockets = await this.server
        .in(`session:${sessionId}`)
        .fetchSockets();

      for (const socket of sockets) {
        const socketMeta = this.socketMeta.get(socket.id);
        if (!socketMeta?.participantId) continue;

        const isWinner = socketMeta.participantId === winner?.participant_id;
        const rank =
          finalLeaderboard.findIndex(
            (e) => e.participant_id === socketMeta.participantId,
          ) + 1;
        const participantEntry = finalLeaderboard.find(
          (e) => e.participant_id === socketMeta.participantId,
        );

        let message: string;
        if (isWinner) {
          message = `🏆 Félicitations ${winner.pseudo} ! Vous avez remporté le quiz !`;
        } else if (rank <= 3) {
          const medal = rank === 2 ? "🥈" : "🥉";
          message = `${medal} Bravo ! Vous terminez sur le podium à la ${rank}ème place !`;
        } else {
          message = `Merci d'avoir participé ! Vous terminez à la ${rank}ème place.`;
        }

        socket.emit("quiz:finished", {
          final_leaderboard: finalLeaderboard.slice(0, 10),
          your_rank: rank,
          your_score: participantEntry?.score || 0,
          is_winner: isWinner,
          winner_pseudo: winner?.pseudo || null,
          total_participants: finalLeaderboard.length,
          total_questions: finalParticipants?.length || 0,
          message,
        });
      }

      // Room créateur (panneau de contrôle et écran de projection) : même
      // événement, sans les champs propres à un joueur. Les sockets créateur
      // sont ignorés par la boucle ci-dessus (pas de participantId) : ils ne
      // reçoivent donc l'événement qu'une fois.
      this.server
        .to(`creator:${sessionId}`)
        .emit("quiz:finished", creatorFinished);

      this.logger.log(`Quiz terminé pour la session ${sessionId}`);
    } catch (error) {
      this.logger.error(`Erreur quiz:end: ${error.message}`);
      client.emit("error", { message: error.message });
    }
  }

  /**
   * Événement: "session:pause"
   * Le créateur met la session en pause.
   */
  @SubscribeMessage("session:pause")
  async handlePauseSession(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { sessionId: string },
  ) {
    if (!this.isCreatorOfSession(client, payload?.sessionId)) return;

    await this.sessionService.updateSessionStatus(payload.sessionId, "paused");
    this.server.to(`session:${payload.sessionId}`).emit("session:paused", {});
  }

  /**
   * Événement: "session:resume"
   * Le créateur reprend la session après une pause.
   */
  @SubscribeMessage("session:resume")
  async handleResumeSession(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { sessionId: string },
  ) {
    if (!this.isCreatorOfSession(client, payload?.sessionId)) return;

    await this.sessionService.updateSessionStatus(payload.sessionId, "active");
    this.server.to(`session:${payload.sessionId}`).emit("session:resumed", {});
  }

  /**
   * Événement: "creator:kick" (issue #5)
   * Le créateur exclut un participant : statut "kicked", "participant:kicked"
   * envoyé au socket du joueur, puis déconnexion. La reconnexion (REST et
   * "participant:join") et le même pseudo sont ensuite refusés.
   */
  @SubscribeMessage("creator:kick")
  async handleCreatorKick(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WsCreatorKickPayload,
  ) {
    try {
      const { sessionId, participantId } = payload ?? ({} as any);

      if (!this.isCreatorOfSession(client, sessionId)) {
        throw new WsException("Seul le créateur peut exclure un participant");
      }
      if (typeof participantId !== "string" || !participantId) {
        throw new WsException("Participant introuvable");
      }

      await this.sessionService.kickParticipant(sessionId, participantId);

      // Prévenir puis déconnecter le(s) socket(s) du joueur exclu. Les
      // métadonnées sont retirées d'abord pour que handleDisconnect ne
      // repasse pas le participant en "disconnected".
      const sockets = await this.server
        .in(`session:${sessionId}`)
        .fetchSockets();
      for (const socket of sockets) {
        const meta = this.socketMeta.get(socket.id);
        if (
          meta?.role !== "participant" ||
          meta.participantId !== participantId
        )
          continue;
        this.socketMeta.delete(socket.id);
        socket.emit("participant:kicked", { reason: "kicked" });
        socket.disconnect(true);
      }

      // Mise à jour habituelle de la liste des participants côté créateur
      this.server.to(`creator:${sessionId}`).emit("participant:disconnected", {
        participant_id: participantId,
        reason: "kicked",
      });

      // Le joueur exclu était peut-être le dernier à ne pas avoir répondu
      await this.closeQuestionIfAllAnswered(sessionId);

      this.logger.log(
        `Participant ${participantId} exclu de la session ${sessionId}`,
      );
    } catch (error) {
      this.logger.error(`Erreur creator:kick: ${error.message}`);
      client.emit("error", { message: error.message });
    }
  }

  // ============================================================
  // CONTRÔLE D'ACCÈS CRÉATEUR
  // ============================================================

  /**
   * Vrai si ce socket a été authentifié via "creator:join" (JWT + propriété
   * de la session vérifiées) pour la session visée. Le rôle seul ne suffit
   * pas : le créateur d'une session ne doit pas pouvoir piloter une autre.
   */
  isCreatorOfSession(client: Socket, sessionId: string | undefined): boolean {
    const meta = this.socketMeta.get(client.id);
    return (
      meta?.role === "creator" &&
      typeof sessionId === "string" &&
      meta.sessionId === sessionId
    );
  }

  // ============================================================
  // CLASSEMENT MASQUÉ (issue #8)
  // ============================================================

  /**
   * Vrai si la session masque le classement aux joueurs
   * (`sessions.show_leaderboard = false`). Colonne absente ou session
   * introuvable : classement visible (comportement historique).
   */
  private async isLeaderboardHidden(sessionId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from("sessions")
      .select("show_leaderboard")
      .eq("id", sessionId)
      .single();
    return data?.show_leaderboard === false;
  }

  /**
   * Appelle `fn` pour chaque socket joueur (rôle "participant") de la
   * session. Les sockets créateur sont ignorés.
   */
  private async forEachPlayerSocket(
    sessionId: string,
    fn: (
      socket: { emit: (event: string, payload: unknown) => unknown },
      participantId: string,
    ) => void,
  ): Promise<void> {
    const sockets = await this.server.in(`session:${sessionId}`).fetchSockets();
    for (const socket of sockets) {
      const meta = this.socketMeta.get(socket.id);
      if (meta?.role !== "participant" || !meta.participantId) continue;
      fn(socket, meta.participantId);
    }
  }

  // ============================================================
  // CLÔTURE DE QUESTION (Interne, issue #6)
  // ============================================================

  /**
   * Clôture la question active si tous les participants actifs (ni
   * "kicked" ni "disconnected") y ont répondu. Sans effet sinon.
   */
  private async closeQuestionIfAllAnswered(sessionId: string): Promise<void> {
    const activeQ = this.activeQuestions.get(sessionId);
    if (!activeQ) return;

    const { answeredCount, totalParticipants } =
      await this.participantService.countActiveAnswers(
        sessionId,
        activeQ.questionId,
      );
    if (totalParticipants > 0 && answeredCount >= totalParticipants) {
      await this.closeQuestion(sessionId, activeQ.questionId, "all_answered");
    }
  }

  /**
   * Clôture une question (timeout ou tout le monde a répondu) :
   * "question:ended" à toute la session, "question:stats" à la room
   * créateur, "question:reveal" à chaque joueur.
   *
   * Idempotent : l'état actif est retiré de façon synchrone avant le premier
   * `await`, donc un second appel concurrent (timer + dernière réponse, ou
   * deux dernières réponses simultanées) ne trouve plus la question et ne
   * réémet rien.
   *
   * @returns vrai si cet appel a effectivement clôturé la question
   */
  async closeQuestion(
    sessionId: string,
    questionId: string,
    reason: QuestionCloseReason,
  ): Promise<boolean> {
    const activeQ = this.activeQuestions.get(sessionId);
    if (!activeQ || activeQ.questionId !== questionId) return false;
    this.activeQuestions.delete(sessionId);
    clearTimeout(activeQ.timerId);

    this.logger.log(
      `Clôture question ${questionId} dans session ${sessionId} (${reason})`,
    );

    try {
      // Marquer les non-répondants comme timeout
      await this.participantService.processTimeouts(sessionId, questionId);

      // Construire le classement mis à jour (avec gaps)
      const leaderboard = await this.participantService.buildSessionLeaderboard(
        sessionId,
        questionId,
      );

      // Broadcast à tous : fin de la question + classement + réponses correctes
      const endedPayload = {
        question_id: questionId,
        correct_answers: activeQ.correctAnswers,
        leaderboard,
      };
      if (activeQ.showLeaderboard) {
        this.server
          .to(`session:${sessionId}`)
          .emit("question:ended", endedPayload);
      } else {
        // Classement masqué (issue #8) : complet pour le créateur, sans
        // classement pour les joueurs
        this.server
          .to(`creator:${sessionId}`)
          .emit("question:ended", endedPayload);
        await this.forEachPlayerSocket(sessionId, (socket) =>
          socket.emit("question:ended", {
            question_id: questionId,
            correct_answers: activeQ.correctAnswers,
          }),
        );
      }

      const stats = await this.participantService.computeQuestionStats(
        sessionId,
        {
          id: questionId,
          options: activeQ.options,
          correct_answers: activeQ.correctAnswers,
        },
      );

      const statsPayload: WsQuestionStatsPayload = {
        questionId,
        distribution: stats.distribution,
        correctAnswers: stats.correctAnswers,
        accuracy: stats.accuracy,
        answeredCount: stats.answeredCount,
        totalParticipants: stats.totalParticipants,
      };
      this.server
        .to(`creator:${sessionId}`)
        .emit("question:stats", statsPayload);

      // Correction individuelle pour chaque joueur connecté
      const sockets = await this.server
        .in(`session:${sessionId}`)
        .fetchSockets();
      for (const socket of sockets) {
        const meta = this.socketMeta.get(socket.id);
        if (meta?.role !== "participant" || !meta.participantId) continue;

        const own = stats.answersByParticipant.get(meta.participantId);
        const revealPayload: WsQuestionRevealPayload = {
          questionId,
          correctAnswers: activeQ.correctAnswers,
          explanation: activeQ.explanation,
          yourAnswers: own?.answers ?? [],
          isCorrect: own?.isCorrect ?? false,
        };
        socket.emit("question:reveal", revealPayload);
      }

      // Classement masqué (issue #8) : score personnel à la place du classement
      if (!activeQ.showLeaderboard) {
        const progress =
          await this.participantService.computeClassProgress(sessionId);
        await this.forEachPlayerSocket(sessionId, (socket, participantId) => {
          const own = progress.participants.get(participantId);
          const payload: WsPlayerScorePayload = {
            score: own?.score ?? 0,
            correctCount: own?.correctCount ?? 0,
            classAccuracy: progress.classAccuracy,
          };
          socket.emit("player:score", payload);
        });
      }

      this.logger.log(
        `Question ${questionId} terminée. Classement mis à jour.`,
      );
    } catch (error) {
      this.logger.error(
        `Erreur clôture question ${questionId}: ${error.message}`,
      );
    }
    return true;
  }
}
