import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { NICKNAME_ERRORS } from "../common/utils/nickname.util";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { SessionService } from "../session/session.service";
import { AssignmentService } from "./assignment.service";
import {
  ASYNC_ANSWER_GRACE_MS,
  generateResumeToken,
  hashResumeToken,
} from "./assignment.util";
import type {
  AssignmentAnswerResponse,
  AssignmentDoneResponse,
  AssignmentNextResponse,
} from "../common/types";

const NOW = Date.parse("2026-11-20T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const CODE = "ABC234";
const TOKEN = generateResumeToken();
const HASH = hashResumeToken(TOKEN);

const QUESTIONS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    text: "Capitale de la France ?",
    type: "single",
    options: [
      { id: "A", text: "Paris" },
      { id: "B", text: "Lyon" },
    ],
    correct_answers: ["A"],
    max_points: 100,
    timer_seconds: 20,
    order_index: 0,
    explanation: "Paris est la capitale.",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    text: "Nombres pairs ?",
    type: "multiple",
    options: [
      { id: "A", text: "2" },
      { id: "B", text: "3" },
      { id: "C", text: "4" },
    ],
    correct_answers: ["A", "C"],
    max_points: 200,
    timer_seconds: 30,
    order_index: 1,
    explanation: null,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    text: "Le ciel est bleu ?",
    type: "single",
    options: [
      { id: "A", text: "Oui" },
      { id: "B", text: "Non" },
    ],
    correct_answers: ["A"],
    max_points: 100,
    timer_seconds: 10,
    order_index: 2,
    explanation: "Diffusion de Rayleigh.",
  },
];

/** Bonne réponse de chaque question (pour le parcours complet). */
const RIGHT: Record<string, string[]> = Object.fromEntries(
  QUESTIONS.map((q) => [q.id, q.correct_answers]),
);

const makeSession = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  quiz_id: "quiz1",
  status: "active",
  mode: "async",
  due_at: new Date(NOW + 24 * HOUR).toISOString(),
  scoring_mode: "speed",
  show_explanations: "each",
  quizzes: {
    title: "Culture",
    total_questions: QUESTIONS.length,
    use_global_timer: false,
    global_timer_seconds: 30,
  },
  ...over,
});

const makeParticipant = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  session_id: "s1",
  pseudo: "Alice",
  score: 0,
  status: "answering",
  current_index: 0,
  question_sent_at: null as string | null,
  resume_token: HASH,
  ...over,
});

interface AnswerState {
  question_id: string;
  answers: string[];
  status: string;
  is_correct: boolean;
  points_earned: number;
  time_taken_ms: number | null;
}

describe("AssignmentService (mode devoir, issue #10)", () => {
  let service: AssignmentService;
  let supabase: SupabaseMock;

  beforeEach(async () => {
    supabase = createSupabaseMock();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignmentService,
        SessionService,
        { provide: SUPABASE_CLIENT, useValue: supabase.client },
      ],
    }).compile();
    service = moduleRef.get(AssignmentService);
  });

  const writes = (table: string, method: "insert" | "update") =>
    supabase
      .queriesFor(table)
      .map((q) => q.calls.find((c) => c.method === method)?.args[0])
      .filter((x) => x !== undefined) as Record<string, any>[];

  /**
   * Prépare les lectures d'un appel next/answer : session, participant (par
   * jeton), questions, réponses déjà enregistrées.
   */
  const prime = (
    session: Record<string, unknown>,
    participant: Record<string, unknown> | null,
    answers: AnswerState[] = [],
  ) => {
    supabase
      .mockResponse("sessions", { data: session })
      .mockResponse("participants", { data: participant })
      .mockResponse("questions", { data: QUESTIONS })
      .mockResponse("participant_answers", { data: answers });
  };

  const orderOf = (participantId = "p1") =>
    service.orderFor({ id: participantId }, QUESTIONS as any).map((q) => q.id);

  // ============================================================
  // START
  // ============================================================

  describe("start", () => {
    it("crée le participant et ne stocke que l'empreinte du jeton", async () => {
      supabase
        .mockResponse("sessions", { data: makeSession() })
        .mockResponse("sessions", { data: { nickname_mode: "free" } })
        .mockResponse("participants", { data: [] }) // aucun exclu
        .mockResponse("participants", { data: { id: "p1", pseudo: "Alice" } });

      const res = await service.start(CODE, "Alice", NOW);

      expect(res.participantId).toBe("p1");
      expect(res.resumeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.assignment).toEqual({
        title: "Culture",
        totalQuestions: 3,
        dueAt: new Date(NOW + 24 * HOUR).toISOString(),
        scoringMode: "speed",
        showExplanations: "each",
      });
      const [inserted] = writes("participants", "insert");
      expect(inserted.resume_token).toBe(hashResumeToken(res.resumeToken));
      expect(inserted.resume_token).not.toBe(res.resumeToken);
      expect(inserted).toMatchObject({
        session_id: "s1",
        pseudo: "Alice",
        score: 0,
        current_index: 0,
        question_sent_at: null,
      });
    });

    it("deux départs donnent deux jetons différents", async () => {
      for (let i = 0; i < 2; i++) {
        supabase
          .mockResponse("sessions", { data: makeSession() })
          .mockResponse("sessions", { data: { nickname_mode: "free" } })
          .mockResponse("participants", { data: [] })
          .mockResponse("participants", { data: { id: `p${i}`, pseudo: "A" } });
      }
      const a = await service.start(CODE, "Alice", NOW);
      const b = await service.start(CODE, "Bruno", NOW);
      expect(a.resumeToken).not.toBe(b.resumeToken);
    });

    it("applique le filtre de pseudos (issue #5)", async () => {
      supabase
        .mockResponse("sessions", { data: makeSession() })
        .mockResponse("sessions", { data: { nickname_mode: "free" } });

      const promise = service.start(CODE, "M3rd3", NOW);
      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(NICKNAME_ERRORS.notAllowed);
      expect(writes("participants", "insert")).toHaveLength(0);
    });

    it("refuse un pseudo déjà pris (409)", async () => {
      supabase
        .mockResponse("sessions", { data: makeSession() })
        .mockResponse("sessions", { data: { nickname_mode: "free" } })
        .mockResponse("participants", { data: [] })
        .mockResponse("participants", {
          error: {
            code: "23505",
            message: "participants_session_id_pseudo_key",
          },
        });

      await expect(service.start(CODE, "Alice", NOW)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("renvoie 404 pour un code inconnu", async () => {
      supabase.mockResponse("sessions", { data: null });
      await expect(service.start(CODE, "Alice", NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("refuse une session live (404, mode: live)", async () => {
      supabase.mockResponse("sessions", {
        data: makeSession({ mode: "live", due_at: null }),
      });
      const err = await service.start(CODE, "Alice", NOW).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.getResponse()).toMatchObject({ mode: "live" });
      expect(writes("participants", "insert")).toHaveLength(0);
    });

    it("refuse un devoir clôturé (410, reason: closed)", async () => {
      supabase.mockResponse("sessions", {
        data: makeSession({ status: "finished" }),
      });
      const err = await service.start(CODE, "Alice", NOW).catch((e) => e);
      expect(err).toBeInstanceOf(GoneException);
      expect(err.getResponse()).toMatchObject({ reason: "closed" });
    });

    it("refuse un devoir échu (410, reason: expired)", async () => {
      supabase.mockResponse("sessions", {
        data: makeSession({ due_at: new Date(NOW - 1).toISOString() }),
      });
      const err = await service.start(CODE, "Alice", NOW).catch((e) => e);
      expect(err).toBeInstanceOf(GoneException);
      expect(err.getResponse()).toMatchObject({ reason: "expired" });
    });
  });

  // ============================================================
  // ÉCHÉANCE
  // ============================================================

  describe("échéance", () => {
    const due = NOW + HOUR;
    const session = makeSession({ due_at: new Date(due).toISOString() });

    it("accepte une requête juste avant l'échéance", async () => {
      supabase.mockResponse("sessions", { data: session });
      await expect(
        service.loadOpenAssignment(CODE, due - 1),
      ).resolves.toMatchObject({ id: "s1" });
    });

    it("refuse une requête à l'échéance ou après (410)", async () => {
      supabase
        .mockResponse("sessions", { data: session })
        .mockResponse("sessions", { data: session });
      await expect(
        service.loadOpenAssignment(CODE, due),
      ).rejects.toBeInstanceOf(GoneException);
      await expect(
        service.loadOpenAssignment(CODE, due + HOUR),
      ).rejects.toBeInstanceOf(GoneException);
    });

    it("refuse une réponse arrivée après l'échéance, même à une question envoyée avant", async () => {
      const order = orderOf();
      supabase.mockResponse("sessions", { data: session });
      await expect(
        service.answer(
          CODE,
          TOKEN,
          { questionId: order[0], answers: ["A"] },
          due + 1,
        ),
      ).rejects.toBeInstanceOf(GoneException);
      expect(writes("participant_answers", "insert")).toHaveLength(0);
    });

    it("après prolongation, le devoir échu est de nouveau accessible", async () => {
      const prolonged = makeSession({
        due_at: new Date(due + 24 * HOUR).toISOString(),
      });
      supabase.mockResponse("sessions", { data: prolonged });
      await expect(
        service.loadOpenAssignment(CODE, due + HOUR),
      ).resolves.toMatchObject({ id: "s1" });
    });

    it("normalise le code saisi (espaces, minuscules)", async () => {
      supabase.mockResponse("sessions", { data: session });
      await service.loadOpenAssignment(" abc 234 ", NOW);
      const lookup = supabase.queriesFor("sessions")[0];
      expect(lookup.calls).toContainEqual({
        method: "eq",
        args: ["password", "ABC234"],
      });
    });
  });

  // ============================================================
  // REPRISE (JETON)
  // ============================================================

  describe("reprise via resumeToken", () => {
    it("refuse un jeton absent ou mal formé sans interroger les participants", async () => {
      for (const token of [undefined, "", "court", "x".repeat(44)]) {
        supabase.mockResponse("sessions", { data: makeSession() });
        await expect(service.next(CODE, token, NOW)).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      }
      expect(supabase.queriesFor("participants")).toHaveLength(0);
    });

    it("refuse un jeton bien formé mais inconnu (401)", async () => {
      prime(makeSession(), null);
      await expect(
        service.next(CODE, generateResumeToken(), NOW),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("recherche le participant par empreinte, dans la session du code", async () => {
      prime(makeSession(), makeParticipant());
      await service.next(CODE, TOKEN, NOW);
      const lookup = supabase.queriesFor("participants")[0];
      expect(lookup.calls).toContainEqual({
        method: "eq",
        args: ["resume_token", HASH],
      });
      expect(lookup.calls).toContainEqual({
        method: "eq",
        args: ["session_id", "s1"],
      });
    });

    it("refuse un participant dont l'empreinte stockée ne correspond pas", async () => {
      prime(
        makeSession(),
        makeParticipant({ resume_token: hashResumeToken("autre") }),
      );
      await expect(service.next(CODE, TOKEN, NOW)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it("refuse un participant exclu (403)", async () => {
      prime(makeSession(), makeParticipant({ status: "kicked" }));
      await expect(service.next(CODE, TOKEN, NOW)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it("reprend sur la question en cours sans relancer le chrono", async () => {
      const order = orderOf();
      const sentAt = new Date(NOW - 5000).toISOString();
      prime(
        makeSession(),
        makeParticipant({ current_index: 0, question_sent_at: sentAt }),
      );

      const res = (await service.next(
        CODE,
        TOKEN,
        NOW,
      )) as AssignmentNextResponse;

      expect(res.done).toBe(false);
      expect(res.question.id).toBe(order[0]);
      expect(res.sentAt).toBe(sentAt);
      const timer = QUESTIONS.find((q) => q.id === order[0])!.timer_seconds;
      expect(res.timeRemainingMs).toBe(timer * 1000 - 5000);
      // Aucune écriture : question_sent_at n'est pas réinitialisée
      expect(writes("participants", "update")).toHaveLength(0);
    });

    it("reprend après les questions déjà traitées", async () => {
      const order = orderOf();
      prime(makeSession(), makeParticipant({ current_index: 1 }), [
        {
          question_id: order[0],
          answers: ["A"],
          status: "answered",
          is_correct: true,
          points_earned: 80,
          time_taken_ms: 3000,
        },
      ]);

      const res = (await service.next(
        CODE,
        TOKEN,
        NOW,
      )) as AssignmentNextResponse;
      expect(res.position).toBe(2);
      expect(res.answeredCount).toBe(1);
      expect(res.question.id).toBe(order[1]);
      expect(res.score).toBe(80);
    });
  });

  // ============================================================
  // NEXT
  // ============================================================

  describe("next", () => {
    it("envoie la question sans bonne réponse ni explication et horodate l'envoi", async () => {
      prime(makeSession(), makeParticipant());

      const res = (await service.next(
        CODE,
        TOKEN,
        NOW,
      )) as AssignmentNextResponse;

      expect(res.done).toBe(false);
      expect(res.position).toBe(1);
      expect(res.total).toBe(3);
      expect(res.sentAt).toBe(new Date(NOW).toISOString());
      expect(Object.keys(res.question).sort()).toEqual(
        [
          "id",
          "imageUrl",
          "maxPoints",
          "options",
          "text",
          "timerSeconds",
          "type",
        ].sort(),
      );
      const json = JSON.stringify(res);
      expect(json).not.toContain("correct_answers");
      expect(json).not.toContain("correctAnswers");
      expect(json).not.toContain("explanation");
      expect(writes("participants", "update")).toEqual([
        { current_index: 0, question_sent_at: new Date(NOW).toISOString() },
      ]);
    });

    it("applique le chrono global du quiz s'il est activé", async () => {
      prime(
        makeSession({
          quizzes: {
            title: "Culture",
            total_questions: 3,
            use_global_timer: true,
            global_timer_seconds: 45,
          },
        }),
        makeParticipant(),
      );
      const res = (await service.next(
        CODE,
        TOKEN,
        NOW,
      )) as AssignmentNextResponse;
      expect(res.question.timerSeconds).toBe(45);
      expect(res.timeRemainingMs).toBe(45000);
    });

    it("chrono dépassé sans réponse : timeout enregistré puis question suivante", async () => {
      const order = orderOf();
      const timer = QUESTIONS.find((q) => q.id === order[0])!.timer_seconds;
      const sentAt = new Date(
        NOW - timer * 1000 - ASYNC_ANSWER_GRACE_MS - 1,
      ).toISOString();
      prime(
        makeSession(),
        makeParticipant({ current_index: 0, question_sent_at: sentAt }),
      );

      const res = (await service.next(
        CODE,
        TOKEN,
        NOW,
      )) as AssignmentNextResponse;

      expect(writes("participant_answers", "insert")).toEqual([
        {
          participant_id: "p1",
          session_id: "s1",
          question_id: order[0],
          answers: [],
          status: "timeout",
          is_correct: false,
          points_earned: 0,
          time_taken_ms: null,
        },
      ]);
      expect(res.question.id).toBe(order[1]);
      expect(res.position).toBe(2);
      expect(res.sentAt).toBe(new Date(NOW).toISOString());
    });

    it("score masqué pendant le devoir si showExplanations = end", async () => {
      prime(makeSession({ show_explanations: "end" }), makeParticipant());
      const res = (await service.next(
        CODE,
        TOKEN,
        NOW,
      )) as AssignmentNextResponse;
      expect(res.score).toBeNull();
    });
  });

  // ============================================================
  // ANSWER
  // ============================================================

  describe("answer", () => {
    const order = () => orderOf();
    const current = () => QUESTIONS.find((q) => q.id === order()[0])!;

    it("calcule le temps côté serveur à partir de question_sent_at", async () => {
      const q = current();
      prime(
        makeSession(),
        makeParticipant({
          current_index: 0,
          question_sent_at: new Date(NOW - 5000).toISOString(),
        }),
      );

      const res = await service.answer(
        CODE,
        TOKEN,
        { questionId: q.id, answers: q.correct_answers },
        NOW,
      );

      const expected = Math.round(
        q.max_points * (1 - 5000 / (q.timer_seconds * 1000)),
      );
      expect(res.timeTakenMs).toBe(5000);
      expect(res.result).toMatchObject({
        isCorrect: true,
        pointsEarned: expected,
        totalScore: expected,
        correctAnswers: q.correct_answers,
        explanation: q.explanation,
      });
      const [row] = writes("participant_answers", "insert");
      expect(row).toMatchObject({
        participant_id: "p1",
        session_id: "s1",
        question_id: q.id,
        status: "answered",
        time_taken_ms: 5000,
        points_earned: expected,
      });
      expect(writes("participants", "update")).toEqual([
        {
          current_index: 1,
          question_sent_at: null,
          score: expected,
          status: "answering",
        },
      ]);
    });

    it("ignore toute durée ou tout score fournis par le client", async () => {
      const q = current();
      prime(
        makeSession(),
        makeParticipant({
          current_index: 0,
          question_sent_at: new Date(NOW - 5000).toISOString(),
        }),
      );
      await service.answer(
        CODE,
        TOKEN,
        {
          questionId: q.id,
          answers: q.correct_answers,
          timeTakenMs: 1,
          points: 9999,
        } as any,
        NOW,
      );
      const [row] = writes("participant_answers", "insert");
      expect(row.time_taken_ms).toBe(5000);
      expect(row.points_earned).toBeLessThan(q.max_points);
      expect(row).not.toHaveProperty("points");
      expect(row).not.toHaveProperty("timeTakenMs");
    });

    it("mode accuracy : points max quel que soit le temps", async () => {
      const q = current();
      prime(
        makeSession({ scoring_mode: "accuracy" }),
        makeParticipant({
          current_index: 0,
          question_sent_at: new Date(NOW - 9000).toISOString(),
        }),
      );
      const res = await service.answer(
        CODE,
        TOKEN,
        { questionId: q.id, answers: q.correct_answers },
        NOW,
      );
      expect(res.result?.pointsEarned).toBe(q.max_points);
    });

    it("mauvaise réponse : 0 point", async () => {
      const q = current();
      prime(
        makeSession(),
        makeParticipant({
          current_index: 0,
          question_sent_at: new Date(NOW - 1000).toISOString(),
        }),
      );
      const res = await service.answer(
        CODE,
        TOKEN,
        { questionId: q.id, answers: ["B"] },
        NOW,
      );
      expect(res.result).toMatchObject({ isCorrect: false, pointsEarned: 0 });
    });

    it("réponse dans la tolérance réseau : acceptée, temps ramené au chrono", async () => {
      const q = current();
      const timerMs = q.timer_seconds * 1000;
      prime(
        makeSession(),
        makeParticipant({
          current_index: 0,
          question_sent_at: new Date(
            NOW - timerMs - ASYNC_ANSWER_GRACE_MS,
          ).toISOString(),
        }),
      );
      const res = await service.answer(
        CODE,
        TOKEN,
        { questionId: q.id, answers: q.correct_answers },
        NOW,
      );
      expect(res.status).toBe("answered");
      expect(res.timeTakenMs).toBe(timerMs);
    });

    it("réponse après le chrono : timeout, 0 point", async () => {
      const q = current();
      prime(
        makeSession(),
        makeParticipant({
          current_index: 0,
          question_sent_at: new Date(
            NOW - q.timer_seconds * 1000 - ASYNC_ANSWER_GRACE_MS - 1,
          ).toISOString(),
        }),
      );
      const res = await service.answer(
        CODE,
        TOKEN,
        { questionId: q.id, answers: q.correct_answers },
        NOW,
      );
      expect(res.status).toBe("timeout");
      expect(res.result).toMatchObject({ isCorrect: false, pointsEarned: 0 });
      expect(writes("participant_answers", "insert")[0]).toMatchObject({
        status: "timeout",
        answers: [],
        points_earned: 0,
        time_taken_ms: null,
      });
    });

    it("double soumission : la seconde est ignorée et renvoie la première", async () => {
      const q = current();
      prime(makeSession(), makeParticipant({ current_index: 1 }), [
        {
          question_id: q.id,
          answers: q.correct_answers,
          status: "answered",
          is_correct: true,
          points_earned: 75,
          time_taken_ms: 5000,
        },
      ]);

      const res = await service.answer(
        CODE,
        TOKEN,
        { questionId: q.id, answers: ["B"] },
        NOW,
      );

      expect(res.alreadyAnswered).toBe(true);
      expect(res.result).toMatchObject({ isCorrect: true, pointsEarned: 75 });
      expect(writes("participant_answers", "insert")).toHaveLength(0);
      expect(writes("participants", "update")).toHaveLength(0);
    });

    it("soumissions concurrentes : la violation d'unicité est traitée comme un doublon", async () => {
      const q = current();
      prime(
        makeSession(),
        makeParticipant({
          current_index: 0,
          question_sent_at: new Date(NOW - 2000).toISOString(),
        }),
      );
      const first: AnswerState = {
        question_id: q.id,
        answers: q.correct_answers,
        status: "answered",
        is_correct: true,
        points_earned: 90,
        time_taken_ms: 2000,
      };
      supabase
        .mockResponse("participant_answers", {
          error: { code: "23505", message: "duplicate key" },
        })
        .mockResponse("participant_answers", { data: first });

      const res = await service.answer(
        CODE,
        TOKEN,
        { questionId: q.id, answers: ["B"] },
        NOW,
      );

      expect(res.alreadyAnswered).toBe(true);
      expect(res.result).toMatchObject({ isCorrect: true, pointsEarned: 90 });
      // Pas de progression ni de score modifiés par la requête perdante
      expect(writes("participants", "update")).toHaveLength(0);
    });

    it("refuse une question qui n'est pas la question en cours (409)", async () => {
      const o = order();
      prime(
        makeSession(),
        makeParticipant({
          current_index: 0,
          question_sent_at: new Date(NOW - 1000).toISOString(),
        }),
      );
      await expect(
        service.answer(CODE, TOKEN, { questionId: o[1], answers: ["A"] }, NOW),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("refuse une réponse à une question jamais envoyée (409)", async () => {
      const q = current();
      prime(makeSession(), makeParticipant({ question_sent_at: null }));
      await expect(
        service.answer(CODE, TOKEN, { questionId: q.id, answers: ["A"] }, NOW),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(writes("participant_answers", "insert")).toHaveLength(0);
    });

    it("showExplanations = end : ni verdict ni explication dans la réponse", async () => {
      const q = current();
      prime(
        makeSession({ show_explanations: "end" }),
        makeParticipant({
          current_index: 0,
          question_sent_at: new Date(NOW - 1000).toISOString(),
        }),
      );
      const res = await service.answer(
        CODE,
        TOKEN,
        { questionId: q.id, answers: q.correct_answers },
        NOW,
      );
      expect(res.result).toBeNull();
      expect(JSON.stringify(res)).not.toContain("explanation");
    });
  });

  // ============================================================
  // MÉLANGE PAR PARTICIPANT
  // ============================================================

  describe("ordre des questions", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...QUESTIONS[0],
      id: `q-${String(i).padStart(2, "0")}`,
      order_index: i,
    }));

    it("est déterministe pour un même participant", () => {
      const a = service.orderFor({ id: "p1" }, many as any).map((q) => q.id);
      const b = service
        .orderFor({ id: "p1" }, [...many].reverse() as any)
        .map((q) => q.id);
      expect(a).toEqual(b);
    });

    it("diffère d'un participant à l'autre et conserve toutes les questions", () => {
      const a = service.orderFor({ id: "p1" }, many as any).map((q) => q.id);
      const b = service.orderFor({ id: "p2" }, many as any).map((q) => q.id);
      expect(a).not.toEqual(b);
      expect([...a].sort()).toEqual(many.map((q) => q.id));
      expect([...b].sort()).toEqual(many.map((q) => q.id));
    });
  });

  // ============================================================
  // PARCOURS COMPLET
  // ============================================================

  describe("parcours complet start → next → answer → fin", () => {
    it("enchaîne les questions et termine avec le bilan", async () => {
      // --- start
      supabase
        .mockResponse("sessions", { data: makeSession() })
        .mockResponse("sessions", { data: { nickname_mode: "free" } })
        .mockResponse("participants", { data: [] })
        .mockResponse("participants", { data: { id: "p1", pseudo: "Alice" } });
      const started = await service.start(CODE, "Alice", NOW);
      const inserted = writes("participants", "insert")[0];
      const participant = makeParticipant({
        resume_token: inserted.resume_token,
      });
      const answers: AnswerState[] = [];
      const order = orderOf("p1");

      // Applique les écritures de l'appel précédent à l'état simulé
      const applyWrites = () => {
        for (const u of writes("participants", "update")) {
          Object.assign(participant, u);
        }
        for (const row of writes("participant_answers", "insert")) {
          const { participant_id: _p, session_id: _s, ...rest } = row;
          answers.push(rest as AnswerState);
        }
        supabase.reset();
      };
      applyWrites();

      let clock = NOW;
      for (let i = 0; i < order.length; i++) {
        // --- next
        prime(makeSession(), { ...participant }, [...answers]);
        const next = (await service.next(
          CODE,
          started.resumeToken,
          clock,
        )) as AssignmentNextResponse;
        applyWrites();
        expect(next.done).toBe(false);
        expect(next.position).toBe(i + 1);
        expect(next.question.id).toBe(order[i]);

        // --- answer, 2 s plus tard
        clock += 2000;
        prime(makeSession(), { ...participant }, [...answers]);
        const res: AssignmentAnswerResponse = await service.answer(
          CODE,
          started.resumeToken,
          { questionId: next.question.id, answers: RIGHT[next.question.id] },
          clock,
        );
        applyWrites();
        expect(res.status).toBe("answered");
        expect(res.timeTakenMs).toBe(2000);
        expect(res.finished).toBe(i === order.length - 1);
        clock += 1000;
      }

      expect(participant.status).toBe("answered");
      expect(participant.question_sent_at).toBeNull();

      // --- fin : next renvoie le bilan
      prime(makeSession(), { ...participant }, [...answers]);
      const done = (await service.next(
        CODE,
        started.resumeToken,
        clock,
      )) as AssignmentDoneResponse;

      const expectedScore = answers.reduce((s, a) => s + a.points_earned, 0);
      expect(done.done).toBe(true);
      expect(done.total).toBe(3);
      expect(done.correctCount).toBe(3);
      expect(done.score).toBe(expectedScore);
      expect(participant.score).toBe(expectedScore);
      expect(done.maxScore).toBe(400);
      expect(done.review.map((r) => r.question.id)).toEqual(order);
      expect(done.review[0].correctAnswers).toEqual(RIGHT[order[0]]);
      // Le bilan n'écrit rien de plus (participant déjà "answered")
      expect(writes("participants", "update")).toHaveLength(0);
    });
  });
});
