import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_CLIENT } from "../database/database.module";
import { SessionService } from "../session/session.service";
import {
  calculatePoints,
  checkAnswer,
  computeServerTimeTakenMs,
  normalizeSessionCode,
  ScoringMode,
} from "../common/utils/scoring.util";
import { NICKNAME_ERRORS } from "../common/utils/nickname.util";
import {
  ASYNC_ANSWER_GRACE_MS,
  generateResumeToken,
  hashResumeToken,
  isWellFormedResumeToken,
  safeEqualHex,
  seededShuffle,
  ShowExplanationsMode,
} from "./assignment.util";
import { SubmitAssignmentAnswerDto } from "./dto/assignment.dto";
import { QuestionType } from "../common/utils/question-types.util";
import { sanitizeSubmittedAnswers } from "../participant/participant.service";
import type {
  AssignmentAnswerResponse,
  AssignmentDoneResponse,
  AssignmentInfo,
  AssignmentNextResponse,
  AssignmentPublicQuestion,
  AssignmentReviewItem,
  AssignmentStartResponse,
} from "../common/types";

/** Session lue pour les endpoints de devoir. */
interface AssignmentSessionRow {
  id: string;
  quiz_id: string;
  status: string;
  mode: string | null;
  due_at: string | null;
  scoring_mode: string | null;
  show_explanations: string | null;
  quizzes:
    | {
        title?: string | null;
        total_questions?: number | null;
        use_global_timer?: boolean | null;
        global_timer_seconds?: number | null;
      }
    | Array<Record<string, unknown>>
    | null;
}

interface AssignmentParticipantRow {
  id: string;
  session_id: string;
  pseudo: string;
  score: number | null;
  status: string;
  current_index: number | null;
  question_sent_at: string | null;
  resume_token: string | null;
}

/** Question telle que stockée (colonnes futures comprises, ex. image_url). */
interface QuestionRow {
  id: string;
  text: string;
  type: string;
  options: Array<{ id: string; text?: string }> | null;
  correct_answers: string[] | null;
  max_points: number;
  timer_seconds: number;
  order_index: number;
  explanation?: string | null;
  image_url?: string | null;
}

interface AnswerRow {
  question_id: string;
  answers: string[] | null;
  status: string;
  is_correct: boolean | null;
  points_earned: number | null;
  time_taken_ms: number | null;
}

const SESSION_COLUMNS =
  "id, quiz_id, status, mode, due_at, scoring_mode, show_explanations, quizzes (title, total_questions, use_global_timer, global_timer_seconds)";
const PARTICIPANT_COLUMNS =
  "id, session_id, pseudo, score, status, current_index, question_sent_at, resume_token";
const ANSWER_COLUMNS =
  "question_id, answers, status, is_correct, points_earned, time_taken_ms";

/** Violation d'unicité Postgres. */
function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

/**
 * Mode devoir asynchrone (issue #10).
 *
 * Chaque élève avance seul dans le quiz par trois appels REST publics
 * (`start`, `next`, `answer`). Le serveur est la seule source de vérité :
 * - ordre des questions propre à l'élève (mélange déterministe, graine =
 *   identifiant du participant, stocké en base) ;
 * - temps de réponse = heure de réception − `participants.question_sent_at`,
 *   qui n'est fixée qu'une fois par question (un nouvel appel à `next` ne
 *   relance pas le chrono) ;
 * - score via `checkAnswer` / `calculatePoints` (mêmes règles que le direct,
 *   y compris les futurs types de question) ;
 * - une seule réponse par question (index unique en base, migration 006) ;
 * - refus après l'échéance (`due_at`) ou la clôture (`status = finished`).
 */
@Injectable()
export class AssignmentService {
  constructor(
    @Inject(SUPABASE_CLIENT) private supabase: SupabaseClient,
    private sessionService: SessionService,
  ) {}

  // ============================================================
  // ENDPOINTS
  // ============================================================

  /** POST /api/assignments/:code/start */
  async start(
    code: string,
    pseudo: string,
    nowMs: number = Date.now(),
  ): Promise<AssignmentStartResponse> {
    const session = await this.loadOpenAssignment(code, nowMs);

    // Filtre de pseudos (issue #5) : mots interdits, mode "generated", exclus
    await this.sessionService.assertNicknameAcceptable(session.id, pseudo);

    const resumeToken = generateResumeToken();
    const { data: participant, error } = await this.supabase
      .from("participants")
      .insert({
        session_id: session.id,
        pseudo,
        score: 0,
        status: "answering",
        current_index: 0,
        question_sent_at: null,
        resume_token: hashResumeToken(resumeToken),
      })
      .select("id, pseudo")
      .single();

    if (isUniqueViolation(error)) {
      throw new ConflictException(
        "Ce pseudo est déjà utilisé dans ce devoir. Pour reprendre, utilisez votre lien de reprise.",
      );
    }
    if (error || !participant) {
      throw new Error(`Erreur création participant: ${error?.message}`);
    }

    return {
      participantId: participant.id,
      pseudo: participant.pseudo,
      resumeToken,
      assignment: this.toInfo(session),
    };
  }

  /** GET /api/assignments/:code/next (en-tête X-Resume-Token) */
  async next(
    code: string,
    resumeToken: string | undefined,
    nowMs: number = Date.now(),
  ): Promise<AssignmentNextResponse | AssignmentDoneResponse> {
    const session = await this.loadOpenAssignment(code, nowMs);
    const participant = await this.loadParticipant(session, resumeToken);
    const [questions, answers] = await Promise.all([
      this.loadQuestions(session),
      this.loadAnswers(participant.id),
    ]);
    const order = this.orderFor(participant, questions);

    let index = this.firstUnansweredIndex(order, answers);
    // Question envoyée dont le chrono est dépassé : enregistrée en "timeout"
    // puis on passe à la suivante (au plus une question envoyée à la fois).
    if (
      index !== -1 &&
      participant.question_sent_at &&
      participant.current_index === index
    ) {
      const question = order[index];
      const elapsed = computeServerTimeTakenMs(
        participant.question_sent_at,
        nowMs,
      );
      const timerMs = this.timerSecondsFor(session, question) * 1000;
      if (elapsed === null || elapsed > timerMs + ASYNC_ANSWER_GRACE_MS) {
        const row = await this.recordAnswer(session, participant, {
          question_id: question.id,
          answers: [],
          status: "timeout",
          is_correct: false,
          points_earned: 0,
          time_taken_ms: null,
        });
        answers.set(question.id, row);
        participant.question_sent_at = null;
        index = this.firstUnansweredIndex(order, answers);
        await this.saveProgress(participant, index, answers, order.length);
      } else {
        return this.toNext(
          session,
          participant,
          order,
          index,
          answers,
          participant.question_sent_at,
          Math.max(0, timerMs - elapsed),
        );
      }
    }

    if (index === -1) {
      if (participant.status !== "answered") {
        await this.saveProgress(participant, -1, answers, order.length);
      }
      return this.toDone(session, participant, order, answers);
    }

    // Nouvelle question : horodatage serveur, fixé une seule fois
    const sentAt = new Date(nowMs).toISOString();
    const { error } = await this.supabase
      .from("participants")
      .update({ current_index: index, question_sent_at: sentAt })
      .eq("id", participant.id);
    if (error) throw new Error(`Erreur envoi question: ${error.message}`);

    const timerMs = this.timerSecondsFor(session, order[index]) * 1000;
    return this.toNext(
      session,
      participant,
      order,
      index,
      answers,
      sentAt,
      timerMs,
    );
  }

  /** POST /api/assignments/:code/answer (en-tête X-Resume-Token) */
  async answer(
    code: string,
    resumeToken: string | undefined,
    dto: SubmitAssignmentAnswerDto,
    nowMs: number = Date.now(),
  ): Promise<AssignmentAnswerResponse> {
    const session = await this.loadOpenAssignment(code, nowMs);
    const participant = await this.loadParticipant(session, resumeToken);
    const [questions, answers] = await Promise.all([
      this.loadQuestions(session),
      this.loadAnswers(participant.id),
    ]);
    const order = this.orderFor(participant, questions);

    // Double soumission : la première réponse fait foi, celle-ci est ignorée
    const existing = answers.get(dto.questionId);
    if (existing) {
      return this.toAnswerResponse(session, order, answers, existing, true);
    }

    const index = this.firstUnansweredIndex(order, answers);
    const question = index === -1 ? undefined : order[index];
    if (
      !question ||
      question.id !== dto.questionId ||
      participant.current_index !== index ||
      !participant.question_sent_at
    ) {
      throw new ConflictException(
        index === -1
          ? "Devoir déjà terminé"
          : "Cette question n'est pas la question en cours : appelez /next",
      );
    }

    // Temps mesuré par le serveur uniquement
    const elapsed = computeServerTimeTakenMs(
      participant.question_sent_at,
      nowMs,
    );
    const timerSeconds = this.timerSecondsFor(session, question);
    const timerMs = timerSeconds * 1000;
    // Même validation de forme que le direct (#7) : 6 éléments au plus,
    // réponse courte unique de 200 caractères au plus. Lève une 400 sinon.
    const submitted = sanitizeSubmittedAnswers(question.type, dto.answers);

    let row: AnswerRow;
    if (elapsed === null || elapsed > timerMs + ASYNC_ANSWER_GRACE_MS) {
      row = {
        question_id: question.id,
        answers: [],
        status: "timeout",
        is_correct: false,
        points_earned: 0,
        time_taken_ms: null,
      };
    } else {
      const timeTakenMs = Math.min(elapsed, timerMs);
      const isCorrect = checkAnswer(
        submitted,
        question.correct_answers ?? [],
        question.type as QuestionType,
      );
      row = {
        question_id: question.id,
        answers: submitted,
        status: "answered",
        is_correct: isCorrect,
        points_earned: calculatePoints(
          isCorrect,
          timeTakenMs,
          timerSeconds,
          question.max_points,
          this.scoringMode(session),
        ),
        time_taken_ms: timeTakenMs,
      };
    }

    const { row: saved, inserted } = await this.insertAnswer(
      session,
      participant,
      row,
    );
    answers.set(saved.question_id, saved);
    if (inserted) {
      await this.saveProgress(
        participant,
        this.firstUnansweredIndex(order, answers),
        answers,
        order.length,
      );
    }

    return this.toAnswerResponse(session, order, answers, saved, !inserted);
  }

  // ============================================================
  // CHARGEMENT ET CONTRÔLES
  // ============================================================

  /**
   * Devoir ouvert correspondant au code. 404 si le code est inconnu ou
   * désigne une session live ; 410 si le devoir est clos ou échu.
   */
  async loadOpenAssignment(
    code: string,
    nowMs: number,
  ): Promise<AssignmentSessionRow> {
    const normalized = normalizeSessionCode(
      typeof code === "string" ? code : "",
    );
    if (!normalized || normalized.length > 20) {
      throw new NotFoundException("Devoir introuvable. Vérifiez le code.");
    }

    const { data: session } = await this.supabase
      .from("sessions")
      .select(SESSION_COLUMNS)
      .eq("password", normalized)
      .maybeSingle();

    if (!session) {
      throw new NotFoundException("Devoir introuvable. Vérifiez le code.");
    }
    const row = session as unknown as AssignmentSessionRow;
    if (row.mode !== "async") {
      // Une session live ne passe jamais par les endpoints de devoir
      throw new NotFoundException({
        statusCode: 404,
        error: "Not Found",
        message: "Ce code correspond à une session en direct, pas à un devoir.",
        mode: "live",
      });
    }
    if (row.status === "finished") {
      throw new GoneException({
        statusCode: 410,
        error: "Gone",
        message: "Ce devoir a été clôturé.",
        reason: "closed",
      });
    }
    const dueMs = row.due_at ? new Date(row.due_at).getTime() : NaN;
    if (!Number.isFinite(dueMs) || nowMs >= dueMs) {
      throw new GoneException({
        statusCode: 410,
        error: "Gone",
        message: "L'échéance de ce devoir est dépassée.",
        reason: "expired",
      });
    }
    return row;
  }

  /** Participant du devoir désigné par le jeton de reprise (401 sinon). */
  private async loadParticipant(
    session: AssignmentSessionRow,
    resumeToken: string | undefined,
  ): Promise<AssignmentParticipantRow> {
    if (!isWellFormedResumeToken(resumeToken)) {
      throw new UnauthorizedException("Jeton de reprise manquant ou invalide");
    }
    const hash = hashResumeToken(resumeToken);

    const { data } = await this.supabase
      .from("participants")
      .select(PARTICIPANT_COLUMNS)
      .eq("session_id", session.id)
      .eq("resume_token", hash)
      .maybeSingle();

    const participant = data as AssignmentParticipantRow | null;
    if (!participant || !safeEqualHex(participant.resume_token, hash)) {
      throw new UnauthorizedException("Jeton de reprise manquant ou invalide");
    }
    if (participant.status === "kicked") {
      throw new ForbiddenException(NICKNAME_ERRORS.kicked);
    }
    return participant;
  }

  private async loadQuestions(
    session: AssignmentSessionRow,
  ): Promise<QuestionRow[]> {
    const { data, error } = await this.supabase
      .from("questions")
      .select("*")
      .eq("quiz_id", session.quiz_id)
      .order("order_index", { ascending: true });
    if (error) throw new Error(`Erreur lecture questions: ${error.message}`);
    return (data ?? []) as QuestionRow[];
  }

  private async loadAnswers(
    participantId: string,
  ): Promise<Map<string, AnswerRow>> {
    const { data, error } = await this.supabase
      .from("participant_answers")
      .select(ANSWER_COLUMNS)
      .eq("participant_id", participantId);
    if (error) throw new Error(`Erreur lecture réponses: ${error.message}`);
    const map = new Map<string, AnswerRow>();
    for (const row of (data ?? []) as AnswerRow[]) {
      if (!map.has(row.question_id)) map.set(row.question_id, row);
    }
    return map;
  }

  // ============================================================
  // LOGIQUE
  // ============================================================

  /**
   * Ordre des questions propre au participant : tri stable (order_index,
   * id) puis mélange déterministe avec l'identifiant du participant comme
   * graine. Le même élève retrouve donc toujours le même ordre.
   */
  orderFor(
    participant: { id: string },
    questions: QuestionRow[],
  ): QuestionRow[] {
    const sorted = [...questions].sort(
      (a, b) => a.order_index - b.order_index || a.id.localeCompare(b.id),
    );
    return seededShuffle(sorted, participant.id);
  }

  private firstUnansweredIndex(
    order: QuestionRow[],
    answers: Map<string, AnswerRow>,
  ): number {
    return order.findIndex((q) => !answers.has(q.id));
  }

  /** Même durée que le direct : chrono global du quiz ou de la question. */
  private timerSecondsFor(
    session: AssignmentSessionRow,
    question: QuestionRow,
  ): number {
    const quiz = this.quizOf(session);
    return quiz?.use_global_timer
      ? Number(quiz.global_timer_seconds)
      : Number(question.timer_seconds);
  }

  private scoringMode(session: AssignmentSessionRow): ScoringMode {
    return session.scoring_mode === "accuracy" ? "accuracy" : "speed";
  }

  private showExplanations(
    session: AssignmentSessionRow,
  ): ShowExplanationsMode {
    return session.show_explanations === "end" ? "end" : "each";
  }

  private quizOf(session: AssignmentSessionRow) {
    const quiz = Array.isArray(session.quizzes)
      ? session.quizzes[0]
      : session.quizzes;
    return (quiz ?? null) as {
      title?: string | null;
      total_questions?: number | null;
      use_global_timer?: boolean | null;
      global_timer_seconds?: number | null;
    } | null;
  }

  /**
   * Insère une réponse. Une violation d'unicité (requêtes concurrentes) n'est
   * pas une erreur : la réponse déjà enregistrée est relue et renvoyée.
   */
  private async insertAnswer(
    session: AssignmentSessionRow,
    participant: AssignmentParticipantRow,
    row: AnswerRow,
  ): Promise<{ row: AnswerRow; inserted: boolean }> {
    const { error } = await this.supabase.from("participant_answers").insert({
      participant_id: participant.id,
      session_id: session.id,
      ...row,
    });
    if (!error) return { row, inserted: true };
    if (!isUniqueViolation(error)) {
      throw new Error(`Erreur enregistrement réponse: ${error.message}`);
    }
    const { data: existing } = await this.supabase
      .from("participant_answers")
      .select(ANSWER_COLUMNS)
      .eq("participant_id", participant.id)
      .eq("question_id", row.question_id)
      .limit(1)
      .maybeSingle();
    return { row: (existing as AnswerRow | null) ?? row, inserted: false };
  }

  private async recordAnswer(
    session: AssignmentSessionRow,
    participant: AssignmentParticipantRow,
    row: AnswerRow,
  ): Promise<AnswerRow> {
    return (await this.insertAnswer(session, participant, row)).row;
  }

  /**
   * Avance le participant : prochaine position, chrono remis à zéro, score =
   * somme des points enregistrés (jamais une valeur reçue du client),
   * statut "answered" une fois toutes les questions traitées.
   */
  private async saveProgress(
    participant: AssignmentParticipantRow,
    nextIndex: number,
    answers: Map<string, AnswerRow>,
    total: number,
  ): Promise<void> {
    const score = this.sumPoints(answers);
    const finished = nextIndex === -1;
    const updates = {
      current_index: finished ? total : nextIndex,
      question_sent_at: null,
      score,
      status: finished ? "answered" : "answering",
    };
    const { error } = await this.supabase
      .from("participants")
      .update(updates)
      .eq("id", participant.id);
    if (error) throw new Error(`Erreur progression: ${error.message}`);
    Object.assign(participant, updates);
  }

  private sumPoints(answers: Map<string, AnswerRow>): number {
    let total = 0;
    for (const a of answers.values()) total += a.points_earned ?? 0;
    return total;
  }

  // ============================================================
  // PAYLOADS
  // ============================================================

  private toInfo(session: AssignmentSessionRow): AssignmentInfo {
    const quiz = this.quizOf(session);
    return {
      title: quiz?.title ?? "",
      totalQuestions: quiz?.total_questions ?? 0,
      dueAt: new Date(session.due_at as string).toISOString(),
      scoringMode: this.scoringMode(session),
      showExplanations: this.showExplanations(session),
    };
  }

  /**
   * Question envoyée à l'élève : liste blanche de champs, jamais
   * `correct_answers` ni `explanation`. Les options d'une question
   * "ordering" sont mélangées (graine = participant + question).
   */
  private toPublicQuestion(
    session: AssignmentSessionRow,
    participant: { id: string },
    question: QuestionRow,
  ): AssignmentPublicQuestion {
    const options = Array.isArray(question.options)
      ? question.options.map((o) => ({ id: o.id, text: o.text ?? "" }))
      : [];
    return {
      id: question.id,
      text: question.text,
      type: question.type,
      options:
        question.type === "ordering"
          ? seededShuffle(options, `${participant.id}:${question.id}`)
          : options,
      imageUrl: question.image_url ?? null,
      maxPoints: question.max_points,
      timerSeconds: this.timerSecondsFor(session, question),
    };
  }

  private toNext(
    session: AssignmentSessionRow,
    participant: AssignmentParticipantRow,
    order: QuestionRow[],
    index: number,
    answers: Map<string, AnswerRow>,
    sentAt: string,
    timeRemainingMs: number,
  ): AssignmentNextResponse {
    return {
      done: false,
      assignment: this.toInfo(session),
      position: index + 1,
      total: order.length,
      answeredCount: answers.size,
      question: this.toPublicQuestion(session, participant, order[index]),
      sentAt: new Date(sentAt).toISOString(),
      timeRemainingMs: Math.round(timeRemainingMs),
      score:
        this.showExplanations(session) === "each"
          ? this.sumPoints(answers)
          : null,
    };
  }

  private toDone(
    session: AssignmentSessionRow,
    participant: AssignmentParticipantRow,
    order: QuestionRow[],
    answers: Map<string, AnswerRow>,
  ): AssignmentDoneResponse {
    const review: AssignmentReviewItem[] = order.map((q, i) => {
      const a = answers.get(q.id);
      return {
        position: i + 1,
        question: this.toPublicQuestion(session, participant, q),
        yourAnswers: a?.answers ?? [],
        status: a?.status === "answered" ? "answered" : "timeout",
        isCorrect: a?.is_correct === true,
        pointsEarned: a?.points_earned ?? 0,
        timeTakenMs: a?.time_taken_ms ?? null,
        correctAnswers: q.correct_answers ?? [],
        explanation: q.explanation ?? null,
      };
    });
    return {
      done: true,
      assignment: this.toInfo(session),
      total: order.length,
      score: this.sumPoints(answers),
      maxScore: order.reduce((sum, q) => sum + (q.max_points ?? 0), 0),
      correctCount: review.filter((r) => r.isCorrect).length,
      review,
    };
  }

  private toAnswerResponse(
    session: AssignmentSessionRow,
    order: QuestionRow[],
    answers: Map<string, AnswerRow>,
    row: AnswerRow,
    alreadyAnswered: boolean,
  ): AssignmentAnswerResponse {
    const question = order.find((q) => q.id === row.question_id);
    const finished = this.firstUnansweredIndex(order, answers) === -1;
    const reveal = this.showExplanations(session) === "each";
    return {
      questionId: row.question_id,
      status: row.status === "answered" ? "answered" : "timeout",
      alreadyAnswered,
      timeTakenMs: row.time_taken_ms ?? null,
      answeredCount: answers.size,
      total: order.length,
      finished,
      result: reveal
        ? {
            isCorrect: row.is_correct === true,
            pointsEarned: row.points_earned ?? 0,
            maxPoints: question?.max_points ?? 0,
            correctAnswers: question?.correct_answers ?? [],
            explanation: question?.explanation ?? null,
            totalScore: this.sumPoints(answers),
          }
        : null,
    };
  }
}
