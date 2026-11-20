import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import {
  ParticipantService,
  sanitizeSubmittedAnswers,
} from "./participant.service";

const answered = (participant_id: string, answers: string[], ok: boolean) => ({
  participant_id,
  answers,
  is_correct: ok,
  status: "answered",
});

describe("ParticipantService : types de question (issue #7)", () => {
  let service: ParticipantService;
  let supabase: SupabaseMock;

  beforeEach(async () => {
    supabase = createSupabaseMock();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ParticipantService,
        { provide: SUPABASE_CLIENT, useValue: supabase.client },
      ],
    }).compile();
    service = moduleRef.get(ParticipantService);
  });

  const mockStats = (ids: string[], rows: unknown[]) =>
    supabase
      .mockResponse("participants", { data: ids.map((id) => ({ id })) })
      .mockResponse("participant_answers", { data: rows });

  describe("computeQuestionStats par type", () => {
    it("true_false : distribution par option true/false", async () => {
      mockStats(
        ["p1", "p2", "p3"],
        [
          answered("p1", ["true"], true),
          answered("p2", ["false"], false),
          answered("p3", ["true"], true),
        ],
      );
      const stats = await service.computeQuestionStats("s1", {
        id: "q1",
        type: "true_false",
        options: [{ id: "true" }, { id: "false" }],
        correct_answers: ["true"],
      });
      expect(stats).toMatchObject({
        type: "true_false",
        distribution: { true: 2, false: 1 },
        accuracy: 67,
        graded: true,
        answeredCount: 3,
      });
    });

    it("ordering : distribution vide, précision juste/faux", async () => {
      mockStats(
        ["p1", "p2"],
        [
          answered("p1", ["C", "A", "B"], true),
          answered("p2", ["A", "B", "C"], false),
        ],
      );
      const stats = await service.computeQuestionStats("s1", {
        id: "q1",
        type: "ordering",
        options: [{ id: "A" }, { id: "B" }, { id: "C" }],
        correct_answers: ["C", "A", "B"],
      });
      expect(stats).toMatchObject({
        distribution: {},
        accuracy: 50,
        graded: true,
        answeredCount: 2,
      });
    });

    it("short_answer : distribution par réponse normalisée", async () => {
      mockStats(
        ["p1", "p2", "p3", "p4"],
        [
          answered("p1", ["Paris"], true),
          answered("p2", ["paris !"], true),
          answered("p3", ["Lyon"], false),
          {
            participant_id: "p4",
            answers: [],
            is_correct: false,
            status: "timeout",
          },
        ],
      );
      const stats = await service.computeQuestionStats("s1", {
        id: "q1",
        type: "short_answer",
        options: [],
        correct_answers: ["Paris"],
      });
      expect(stats).toMatchObject({
        distribution: { paris: 2, lyon: 1 },
        accuracy: 50,
        graded: true,
        answeredCount: 3,
        totalParticipants: 4,
      });
    });

    it("poll : distribution par option, non noté, précision 0", async () => {
      mockStats(
        ["p1", "p2"],
        [
          answered("p1", ["A"], true), // même une ligne incohérente
          answered("p2", ["B"], false),
        ],
      );
      const stats = await service.computeQuestionStats("s1", {
        id: "q1",
        type: "poll",
        options: [{ id: "A" }, { id: "B" }, { id: "C" }],
        correct_answers: [],
      });
      expect(stats).toMatchObject({
        distribution: { A: 1, B: 1, C: 0 },
        accuracy: 0,
        graded: false,
        answeredCount: 2,
      });
      expect(stats.answersByParticipant.get("p1")?.isCorrect).toBe(false);
    });

    it("sans type : traité comme single (rétrocompatible)", async () => {
      mockStats(["p1"], [answered("p1", ["A"], true)]);
      const stats = await service.computeQuestionStats("s1", {
        id: "q1",
        options: [{ id: "A" }, { id: "B" }],
        correct_answers: ["A"],
      });
      expect(stats).toMatchObject({
        type: "single",
        distribution: { A: 1, B: 0 },
        accuracy: 100,
        graded: true,
      });
    });
  });

  describe("submitAnswer par type", () => {
    const START = "2026-01-01T10:00:00.000Z";
    const startMs = new Date(START).getTime();

    const mockSubmission = (
      question: Record<string, unknown>,
      scored: boolean,
    ) => {
      supabase
        .mockResponse("participant_answers", { data: null })
        .mockResponse("questions", {
          data: { id: "q1", timer_seconds: 30, max_points: 100, ...question },
        })
        .mockResponse("sessions", {
          data: {
            question_start_time: START,
            scoring_mode: "speed",
            quizzes: { use_global_timer: false, global_timer_seconds: 30 },
          },
        })
        .mockResponse("participant_answers", { data: null });
      if (scored) {
        supabase
          .mockResponse("participants", { data: { score: 0 } })
          .mockResponse("participants", { data: null });
      }
      supabase
        .mockResponse("participants", {
          data: [{ id: "p1", pseudo: "A", score: 0 }],
        })
        .mockResponse("participant_answers", { data: [] });
    };

    const submit = (answers: unknown) =>
      service.submitAnswer({
        participantId: "p1",
        sessionId: "s1",
        questionId: "q1",
        answers: answers as string[],
        receivedAtMs: startMs,
      });

    const inserted = () =>
      supabase
        .queriesFor("participant_answers")
        .flatMap((q) => q.calls)
        .find((c) => c.method === "insert")?.args[0] as any;

    it("poll : jamais juste, 0 point", async () => {
      mockSubmission({ type: "poll", correct_answers: [] }, false);
      const result = await submit(["A"]);
      expect(result).toMatchObject({ isCorrect: false, pointsEarned: 0 });
      expect(inserted()).toMatchObject({ answers: ["A"], is_correct: false });
    });

    it("short_answer : réponse normalisée juste, texte rogné enregistré", async () => {
      mockSubmission(
        { type: "short_answer", correct_answers: ["Élysée"] },
        true,
      );
      const result = await submit(["  elysee !  "]);
      expect(result).toMatchObject({ isCorrect: true, pointsEarned: 100 });
      expect(inserted().answers).toEqual(["elysee !"]);
    });

    it("ordering : séquence exacte", async () => {
      mockSubmission(
        { type: "ordering", correct_answers: ["B", "C", "A"] },
        true,
      );
      expect((await submit(["B", "C", "A"])).isCorrect).toBe(true);
    });

    it("refuse une réponse mal formée", async () => {
      mockSubmission({ type: "short_answer", correct_answers: ["x"] }, false);
      await expect(submit(["x".repeat(201)])).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("sanitizeSubmittedAnswers", () => {
    it("refuse ce qui n'est pas un tableau de chaînes (≤ 6)", () => {
      for (const bad of [null, "A", [1], ["A", "B", "C", "D", "E", "F", "G"]]) {
        expect(() => sanitizeSubmittedAnswers("single", bad)).toThrow(
          BadRequestException,
        );
      }
      expect(sanitizeSubmittedAnswers("ordering", ["C", "A", "B"])).toEqual([
        "C",
        "A",
        "B",
      ]);
    });

    it("short_answer : un seul texte, rogné, 200 caractères au plus", () => {
      expect(sanitizeSubmittedAnswers("short_answer", [" Rome "])).toEqual([
        "Rome",
      ]);
      expect(sanitizeSubmittedAnswers("short_answer", ["   "])).toEqual([]);
      expect(() =>
        sanitizeSubmittedAnswers("short_answer", ["a", "b"]),
      ).toThrow(BadRequestException);
      expect(() =>
        sanitizeSubmittedAnswers("short_answer", ["x".repeat(201)]),
      ).toThrow(BadRequestException);
    });
  });

  describe("précisions sans les sondages (poll)", () => {
    it("computeClassProgress ignore les réponses aux questions poll", async () => {
      supabase
        .mockResponse("participants", {
          data: [{ id: "p1", score: 100, status: "answered" }],
        })
        .mockResponse("participant_answers", {
          data: [
            {
              id: "a1",
              participant_id: "p1",
              is_correct: true,
              questions: { type: "single" },
            },
            {
              id: "a2",
              participant_id: "p1",
              is_correct: false,
              questions: { type: "poll" },
            },
            {
              id: "a3",
              participant_id: "p1",
              is_correct: false,
              questions: [{ type: "poll" }],
            },
          ],
        });
      const progress = await service.computeClassProgress("s1");
      expect(progress.classAccuracy).toBe(100);
      expect(progress.participants.get("p1")?.correctCount).toBe(1);
      const select = supabase
        .queriesFor("participant_answers")[0]
        .calls.find((c) => c.method === "select");
      expect(String(select?.args[0])).toContain("questions (type)");
    });

    it("getParticipantSummary : précision hors poll", async () => {
      supabase
        .mockResponse("participants", {
          data: { id: "p1", pseudo: "A", score: 100, status: "answered" },
        })
        .mockResponse("participant_answers", {
          data: [
            { is_correct: true, questions: { type: "single" } },
            { is_correct: false, questions: { type: "single" } },
            { is_correct: false, questions: { type: "poll" } },
          ],
        });
      const summary = await service.getParticipantSummary("p1", "s1");
      expect(summary).toMatchObject({
        correct_count: 1,
        total_answers: 3,
        accuracy: 50,
      });
    });
  });
});
