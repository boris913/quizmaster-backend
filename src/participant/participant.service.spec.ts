import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { ParticipantService } from "./participant.service";

describe("ParticipantService (exemple d'utilisation du mock Supabase)", () => {
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

  describe("getParticipantSummary", () => {
    it("calcule le nombre de bonnes réponses et la précision", async () => {
      supabase
        .mockResponse("participants", {
          data: { id: "p1", pseudo: "Alice", score: 250, status: "waiting" },
        })
        .mockResponse("participant_answers", {
          data: [
            { is_correct: true, points_earned: 100, time_taken_ms: 1000 },
            { is_correct: true, points_earned: 150, time_taken_ms: 2000 },
            { is_correct: false, points_earned: 0, time_taken_ms: null },
          ],
        });

      const summary = await service.getParticipantSummary("p1", "s1");

      expect(summary).toEqual({
        id: "p1",
        pseudo: "Alice",
        score: 250,
        status: "waiting",
        correct_count: 2,
        total_answers: 3,
        accuracy: 67,
      });

      const [participantQuery] = supabase.queriesFor("participants");
      expect(participantQuery.calls).toEqual([
        { method: "select", args: ["id, pseudo, score, status"] },
        { method: "eq", args: ["id", "p1"] },
        { method: "eq", args: ["session_id", "s1"] },
        { method: "single", args: [] },
      ]);
    });

    it("renvoie null si le participant n'existe pas", async () => {
      supabase.mockResponse("participants", { data: null });

      await expect(
        service.getParticipantSummary("x", "s1"),
      ).resolves.toBeNull();
      expect(supabase.queriesFor("participant_answers")).toHaveLength(0);
    });
  });

  describe("submitAnswer", () => {
    const params = {
      participantId: "p1",
      sessionId: "s1",
      questionId: "q1",
      answers: ["A"],
    };

    const START = "2026-01-01T10:00:00.000Z";
    const startMs = new Date(START).getTime();
    const question = {
      id: "q1",
      type: "single",
      correct_answers: ["A"],
      timer_seconds: 30,
      max_points: 100,
    };

    /** Prépare une soumission valide (pas de réponse existante). */
    const mockSubmission = (
      sessionData: Record<string, unknown> = {
        question_start_time: START,
        quizzes: { use_global_timer: false, global_timer_seconds: 30 },
      },
      scored = true,
    ) => {
      supabase
        .mockResponse("participant_answers", { data: null }) // pas de doublon
        .mockResponse("questions", { data: question })
        .mockResponse("sessions", { data: sessionData })
        .mockResponse("participant_answers", { data: null }); // insert
      if (scored) {
        // Lecture puis mise à jour du score (sautées si 0 point)
        supabase
          .mockResponse("participants", { data: { score: 0 } })
          .mockResponse("participants", { data: null });
      }
      supabase
        .mockResponse("participants", {
          data: [{ id: "p1", pseudo: "Alice", score: 50 }],
        })
        .mockResponse("participant_answers", { data: [] });
    };

    const insertedAnswer = () => {
      const insert = supabase
        .queriesFor("participant_answers")
        .flatMap((q) => q.calls)
        .find((c) => c.method === "insert");
      return insert?.args[0] as Record<string, unknown>;
    };

    it("calcule le temps côté serveur depuis question_start_time", async () => {
      mockSubmission();

      const result = await service.submitAnswer({
        ...params,
        receivedAtMs: startMs + 15000,
      });

      expect(result.timeTakenMs).toBe(15000);
      expect(result.pointsEarned).toBe(50);
      expect(insertedAnswer()).toMatchObject({
        time_taken_ms: 15000,
        points_earned: 50,
        is_correct: true,
      });
    });

    it("ignore toute durée envoyée par le client", async () => {
      mockSubmission();

      const result = await service.submitAnswer({
        ...params,
        // Champ superflu qu'un client modifié pourrait envoyer
        ...({ timeTakenMs: -3000 } as object),
        receivedAtMs: startMs + 15000,
      });

      expect(result.timeTakenMs).toBe(15000);
      expect(result.pointsEarned).toBe(50);
    });

    it("ne dépasse jamais max_points si l'horloge donne un temps négatif", async () => {
      mockSubmission();

      const result = await service.submitAnswer({
        ...params,
        receivedAtMs: startMs - 3000,
      });

      expect(result.timeTakenMs).toBe(0);
      expect(result.pointsEarned).toBe(100);
    });

    it("donne 0 point à une réponse juste arrivée après la fin du timer", async () => {
      mockSubmission(undefined, false);

      const result = await service.submitAnswer({
        ...params,
        receivedAtMs: startMs + 31000,
      });

      expect(result.pointsEarned).toBe(0);
      expect(insertedAnswer()).toMatchObject({
        time_taken_ms: 30000,
        points_earned: 0,
      });
    });

    it("utilise le timer global du quiz quand il est activé", async () => {
      mockSubmission({
        question_start_time: START,
        quizzes: { use_global_timer: true, global_timer_seconds: 60 },
      });

      const result = await service.submitAnswer({
        ...params,
        receivedAtMs: startMs + 45000,
      });

      // 100 × (1 - 45/60) = 25 (avec le timer de la question, 30 s, ce serait 0)
      expect(result.pointsEarned).toBe(25);
    });

    it("refuse la réponse si aucune question n'a démarré", async () => {
      supabase
        .mockResponse("participant_answers", { data: null })
        .mockResponse("questions", { data: question })
        .mockResponse("sessions", { data: { question_start_time: null } });

      await expect(service.submitAnswer(params)).rejects.toThrow(
        "Aucune question en cours",
      );
      expect(insertedAnswer()).toBeUndefined();
    });

    it("refuse une deuxième réponse à la même question", async () => {
      supabase.mockResponse("participant_answers", { data: { id: "a1" } });

      await expect(service.submitAnswer(params)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(supabase.queriesFor("questions")).toHaveLength(0);
    });

    it("refuse une question introuvable", async () => {
      supabase.mockResponse("questions", {
        data: null,
        error: { message: "not found" },
      });

      await expect(service.submitAnswer(params)).rejects.toThrow(
        "Question introuvable",
      );
    });
  });
});
