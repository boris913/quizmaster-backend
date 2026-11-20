import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { ParticipantService } from "./participant.service";

describe("ParticipantService : modes de score et classement masqué (issue #8)", () => {
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

  describe("submitAnswer selon sessions.scoring_mode", () => {
    const START = "2026-01-01T10:00:00.000Z";
    const startMs = new Date(START).getTime();
    const params = {
      participantId: "p1",
      sessionId: "s1",
      questionId: "q1",
      answers: ["A"],
    };

    const mockSubmission = (scoringMode: unknown, scored = true) => {
      supabase
        .mockResponse("participant_answers", { data: null })
        .mockResponse("questions", {
          data: {
            id: "q1",
            type: "single",
            correct_answers: ["A"],
            timer_seconds: 30,
            max_points: 100,
          },
        })
        .mockResponse("sessions", {
          data: {
            question_start_time: START,
            scoring_mode: scoringMode,
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
          data: [{ id: "p1", pseudo: "Alice", score: 100 }],
        })
        .mockResponse("participant_answers", { data: [] });
    };

    it("lit le mode de score de la session", async () => {
      mockSubmission("accuracy");
      await service.submitAnswer({ ...params, receivedAtMs: startMs + 25000 });
      const select = supabase
        .queriesFor("sessions")[0]
        .calls.find((c) => c.method === "select");
      expect(String(select?.args[0])).toContain("scoring_mode");
    });

    it("accuracy : bonne réponse lente = max_points", async () => {
      mockSubmission("accuracy");
      const result = await service.submitAnswer({
        ...params,
        receivedAtMs: startMs + 25000,
      });
      expect(result.pointsEarned).toBe(100);
    });

    it("accuracy : réponse hors délai = 0", async () => {
      mockSubmission("accuracy", false);
      const result = await service.submitAnswer({
        ...params,
        receivedAtMs: startMs + 30001,
      });
      expect(result.pointsEarned).toBe(0);
    });

    it("speed, ou mode absent (migration non appliquée) : points dégressifs", async () => {
      mockSubmission("speed");
      const speed = await service.submitAnswer({
        ...params,
        receivedAtMs: startMs + 15000,
      });
      expect(speed.pointsEarned).toBe(50);

      mockSubmission(undefined);
      const missing = await service.submitAnswer({
        ...params,
        receivedAtMs: startMs + 15000,
      });
      expect(missing.pointsEarned).toBe(50);
    });
  });

  describe("computeClassProgress", () => {
    it("calcule score, bonnes réponses et précision de la classe, sans les exclus", async () => {
      supabase
        .mockResponse("participants", {
          data: [
            { id: "p1", score: 300, status: "answered" },
            { id: "p2", score: 0, status: "disconnected" },
            { id: "p3", score: 900, status: "kicked" },
          ],
        })
        .mockResponse("participant_answers", {
          data: [
            { id: "a1", participant_id: "p1", is_correct: true },
            { id: "a2", participant_id: "p1", is_correct: true },
            { id: "a3", participant_id: "p2", is_correct: false },
            { id: "a4", participant_id: "p2", is_correct: false },
            // Participant exclu : ignoré
            { id: "a5", participant_id: "p3", is_correct: true },
            { id: "a6", participant_id: "p3", is_correct: true },
          ],
        });

      const progress = await service.computeClassProgress("s1");

      expect(progress.classAccuracy).toBe(50); // 2 / 4
      expect(progress.participants.get("p1")).toEqual({
        score: 300,
        correctCount: 2,
      });
      expect(progress.participants.get("p2")).toEqual({
        score: 0,
        correctCount: 0,
      });
      expect(progress.participants.has("p3")).toBe(false);

      const answersQuery = supabase.queriesFor("participant_answers")[0];
      expect(answersQuery.calls).toEqual(
        expect.arrayContaining([
          { method: "eq", args: ["session_id", "s1"] },
          { method: "range", args: [0, 999] },
        ]),
      );
    });

    it("lit toutes les réponses au-delà de 1000 lignes (pagination)", async () => {
      const page1 = Array.from({ length: 1000 }, (_, i) => ({
        id: `a${i}`,
        participant_id: "p1",
        is_correct: true,
      }));
      const page2 = Array.from({ length: 1000 }, (_, i) => ({
        id: `b${i}`,
        participant_id: "p1",
        is_correct: false,
      }));
      supabase
        .mockResponse("participants", {
          data: [{ id: "p1", score: 10, status: "answered" }],
        })
        .mockResponse("participant_answers", { data: page1 })
        .mockResponse("participant_answers", { data: page2 })
        .mockResponse("participant_answers", { data: [] });

      const progress = await service.computeClassProgress("s1");

      expect(progress.classAccuracy).toBe(50);
      expect(progress.participants.get("p1")?.correctCount).toBe(1000);
      expect(supabase.queriesFor("participant_answers")).toHaveLength(3);
    });

    it("renvoie 0 % sans aucune réponse", async () => {
      supabase.mockResponse("participants", {
        data: [{ id: "p1", score: 0, status: "waiting" }],
      });
      const progress = await service.computeClassProgress("s1");
      expect(progress.classAccuracy).toBe(0);
      expect(progress.participants.get("p1")).toEqual({
        score: 0,
        correctCount: 0,
      });
    });
  });
});
