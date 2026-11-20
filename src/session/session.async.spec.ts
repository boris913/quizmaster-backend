import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import {
  ASYNC_LIVE_FORBIDDEN,
  parseDueAt,
  SessionService,
} from "./session.service";

const OWNER = "user-owner";
const OTHER = "user-other";
const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

describe("SessionService : mode devoir (issue #10)", () => {
  let service: SessionService;
  let supabase: SupabaseMock;

  beforeEach(async () => {
    supabase = createSupabaseMock();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: SUPABASE_CLIENT, useValue: supabase.client },
      ],
    }).compile();
    service = moduleRef.get(SessionService);
  });

  const writes = (table: string, method: "insert" | "update") =>
    supabase
      .queriesFor(table)
      .map((q) => q.calls.find((c) => c.method === method)?.args[0])
      .filter((x) => x !== undefined) as Record<string, any>[];

  const quiz = {
    id: "quiz1",
    creator_id: OWNER,
    total_questions: 3,
    title: "Mon quiz",
  };

  describe("createSession", () => {
    it("crée un devoir ouvert avec échéance et mode d'explication", async () => {
      const dueAt = inHours(48);
      supabase
        .mockResponse("quizzes", { data: quiz })
        .mockResponse("sessions", { data: { id: "s1", mode: "async" } });

      await service.createSession(OWNER, {
        quiz_id: "quiz1",
        mode: "async",
        dueAt,
        showExplanations: "end",
      });

      const [inserted] = writes("sessions", "insert");
      expect(inserted).toMatchObject({
        mode: "async",
        due_at: new Date(dueAt).toISOString(),
        show_explanations: "end",
        status: "active",
      });
      expect(inserted.started_at).toEqual(expect.any(String));
    });

    it("par défaut : session live, sans échéance", async () => {
      supabase
        .mockResponse("quizzes", { data: quiz })
        .mockResponse("sessions", { data: { id: "s1" } });

      await service.createSession(OWNER, { quiz_id: "quiz1" });

      const [inserted] = writes("sessions", "insert");
      expect(inserted).toMatchObject({ mode: "live", status: "waiting" });
      expect(inserted).not.toHaveProperty("due_at");
    });

    it.each([
      ["sans échéance", { mode: "async" }],
      ["échéance passée", { mode: "async", dueAt: inHours(-1) }],
      ["échéance sans fuseau", { mode: "async", dueAt: "2030-01-01T10:00:00" }],
      ["échéance trop lointaine", { mode: "async", dueAt: inHours(24 * 400) }],
      ["live avec échéance", { mode: "live", dueAt: inHours(2) }],
      ["live avec showExplanations", { showExplanations: "end" }],
    ])("refuse : %s (400)", async (_label, extra) => {
      supabase.mockResponse("quizzes", { data: quiz });
      await expect(
        service.createSession(OWNER, { quiz_id: "quiz1", ...(extra as any) }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(writes("sessions", "insert")).toHaveLength(0);
    });
  });

  describe("updateSession (PATCH /api/sessions/:id)", () => {
    const owned = () =>
      supabase.mockResponse("sessions", { data: { creator_id: OWNER } });

    it("prolonge l'échéance d'un devoir", async () => {
      const dueAt = inHours(72);
      owned()
        .mockResponse("sessions", {
          data: { id: "s1", mode: "async", status: "active" },
        })
        .mockResponse("sessions", { data: { id: "s1", due_at: dueAt } });

      await service.updateSession("s1", OWNER, { dueAt });

      expect(writes("sessions", "update")).toEqual([
        { due_at: new Date(dueAt).toISOString() },
      ]);
    });

    it("clôt un devoir", async () => {
      owned()
        .mockResponse("sessions", {
          data: { id: "s1", mode: "async", status: "active" },
        })
        .mockResponse("sessions", { data: { id: "s1", status: "finished" } });

      await service.updateSession("s1", OWNER, { status: "finished" });

      const [update] = writes("sessions", "update");
      expect(update).toMatchObject({ status: "finished" });
      expect(update.ended_at).toEqual(expect.any(String));
    });

    it("renvoie 404 pour la session d'un autre créateur", async () => {
      owned();
      await expect(
        service.updateSession("s1", OTHER, { status: "finished" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(writes("sessions", "update")).toHaveLength(0);
    });

    it("refuse une session live (400)", async () => {
      owned().mockResponse("sessions", {
        data: { id: "s1", mode: "live", status: "waiting" },
      });
      await expect(
        service.updateSession("s1", OWNER, { dueAt: inHours(2) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuse un devoir déjà clôturé (409)", async () => {
      owned().mockResponse("sessions", {
        data: { id: "s1", mode: "async", status: "finished" },
      });
      await expect(
        service.updateSession("s1", OWNER, { dueAt: inHours(2) }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([
      ["corps vide", {}],
      ["les deux à la fois", { dueAt: inHours(2), status: "finished" }],
    ])("refuse : %s (400)", async (_label, dto) => {
      owned();
      await expect(
        service.updateSession("s1", OWNER, dto as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuse une prolongation dans le passé (400)", async () => {
      owned().mockResponse("sessions", {
        data: { id: "s1", mode: "async", status: "active" },
      });
      await expect(
        service.updateSession("s1", OWNER, { dueAt: inHours(-2) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("un devoir n'est pas accessible en direct", () => {
    const asyncSession = {
      id: "s1",
      status: "active",
      mode: "async",
      quiz_id: "quiz1",
      nickname_mode: "free",
      quizzes: { title: "Mon quiz", total_questions: 3 },
    };

    it("POST /sessions/join refuse un code de devoir (404, mode: async)", async () => {
      supabase.mockResponse("sessions", { data: asyncSession });
      const err = await service
        .joinSession({ password: "ABC234", pseudo: "Alice" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.getResponse()).toMatchObject({ mode: "async" });
      expect(writes("participants", "insert")).toHaveLength(0);
    });

    it("la reconnexion live refuse un participant de devoir (404)", async () => {
      supabase
        .mockResponse("participants", {
          data: {
            id: "p1",
            session_id: "s1",
            pseudo: "Alice",
            status: "answering",
          },
        })
        .mockResponse("sessions", { data: asyncSession });
      await expect(
        service.reconnectParticipant("s1", "p1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("participant:join (socket) refuse un devoir (403)", async () => {
      supabase
        .mockResponse("participants", {
          data: {
            id: "p1",
            session_id: "s1",
            pseudo: "Alice",
            status: "answering",
          },
        })
        .mockResponse("sessions", { data: asyncSession });
      const promise = service.assertParticipantCanJoin("s1", "p1");
      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      await expect(promise).rejects.toThrow(ASYNC_LIVE_FORBIDDEN);
    });
  });

  describe("GET /sessions/:id/results pour un devoir", () => {
    it("inclut les réponses des élèves, le mode et l'échéance", async () => {
      const dueAt = inHours(5);
      supabase
        .mockResponse("sessions", {
          data: {
            id: "s1",
            creator_id: OWNER,
            quiz_id: "quiz1",
            status: "active",
            mode: "async",
            due_at: dueAt,
            started_at: inHours(-1),
            ended_at: null,
            quizzes: { title: "Mon quiz" },
          },
        })
        .mockResponse("questions", {
          data: [
            {
              id: "q1",
              order_index: 0,
              text: "Q1",
              type: "single",
              options: [{ id: "A" }, { id: "B" }],
              correct_answers: ["A"],
            },
          ],
        })
        .mockResponse("participants", {
          data: [
            { id: "p1", pseudo: "Alice", score: 80 },
            { id: "p2", pseudo: "Bruno", score: 0 },
          ],
        })
        .mockResponse("participant_answers", {
          data: [
            {
              participant_id: "p1",
              question_id: "q1",
              answers: ["A"],
              status: "answered",
              is_correct: true,
              time_taken_ms: 4000,
            },
            {
              participant_id: "p2",
              question_id: "q1",
              answers: [],
              status: "timeout",
              is_correct: false,
              time_taken_ms: null,
            },
          ],
        });

      const results = await service.getSessionResults("s1", OWNER);

      expect(results.session).toMatchObject({
        mode: "async",
        dueAt,
        participantCount: 2,
      });
      expect(results.perParticipant).toEqual([
        expect.objectContaining({ pseudo: "Alice", score: 80, answered: 1 }),
        expect.objectContaining({ pseudo: "Bruno", timeouts: 1 }),
      ]);
      expect(results.perQuestion[0]).toMatchObject({
        accuracy: 0.5,
        avgTimeMs: 4000,
        answerDistribution: { A: 1, B: 0 },
      });
    });
  });

  describe("parseDueAt", () => {
    const now = Date.parse("2026-11-20T10:00:00Z");
    it("accepte un fuseau explicite et normalise en UTC", () => {
      expect(parseDueAt("2026-11-21T12:00:00+02:00", now)).toBe(
        "2026-11-21T10:00:00.000Z",
      );
    });
    it("refuse une date invalide", () => {
      expect(() => parseDueAt("2026-13-45T00:00:00Z", now)).toThrow(
        BadRequestException,
      );
    });
  });
});
