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
      timeTakenMs: 1000,
    };

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
