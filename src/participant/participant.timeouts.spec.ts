import { ConflictException, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import {
  ANSWER_ALREADY_RECORDED,
  ParticipantService,
} from "./participant.service";

/**
 * Course réponse / timeout en direct avec l'index unique
 * participant_answers (participant_id, question_id) de la migration 006.
 */
describe("ParticipantService : course réponse/timeout (index unique, #10)", () => {
  let service: ParticipantService;
  let supabase: SupabaseMock;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

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

  const callsOf = (method: string) =>
    supabase
      .queriesFor("participant_answers")
      .flatMap((q) => q.calls)
      .filter((c) => c.method === method);

  /** p1 a répondu, p2 et p3 non. */
  const mockParticipantsAndAnswers = () =>
    supabase
      .mockResponse("participants", {
        data: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      })
      .mockResponse("participant_answers", {
        data: [{ participant_id: "p1" }],
      });

  describe("processTimeouts", () => {
    it("insère les timeouts par upsert en ignorant les doublons", async () => {
      mockParticipantsAndAnswers();

      await service.processTimeouts("s1", "q1");

      const [upsert] = callsOf("upsert");
      expect(upsert.args[1]).toEqual({
        onConflict: "participant_id,question_id",
        ignoreDuplicates: true,
      });
      expect(
        (upsert.args[0] as { participant_id: string }[]).map(
          (r) => r.participant_id,
        ),
      ).toEqual(["p2", "p3"]);
      expect(callsOf("insert")).toHaveLength(0);
      // Les non-répondants repassent en "waiting"
      const reset = supabase
        .queriesFor("participants")
        .flatMap((q) => q.calls)
        .find((c) => c.method === "in");
      expect(reset?.args).toEqual(["id", ["p2", "p3"]]);
    });

    it("repli sur une insertion simple si l'index unique est absent (42P10)", async () => {
      mockParticipantsAndAnswers();
      supabase.mockResponse("participant_answers", {
        error: { code: "42P10", message: "no unique constraint" },
      });

      await service.processTimeouts("s1", "q1");

      expect(callsOf("upsert")).toHaveLength(1);
      expect(callsOf("insert")).toHaveLength(1);
    });

    it("ne lève jamais d'erreur : la clôture de la question continue", async () => {
      mockParticipantsAndAnswers();
      supabase.mockResponse("participant_answers", {
        error: { code: "23505", message: "duplicate key" },
      });

      await expect(service.processTimeouts("s1", "q1")).resolves.toBe(
        undefined,
      );
    });
  });

  describe("submitAnswer après un timeout déjà inséré", () => {
    it("refuse proprement (409) sans compter de points", async () => {
      const START = "2026-01-01T10:00:00.000Z";
      supabase
        .mockResponse("participant_answers", { data: null }) // pas encore de ligne
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
            quizzes: { use_global_timer: false, global_timer_seconds: 30 },
          },
        })
        // Le timeout de la clôture a été inséré entre-temps
        .mockResponse("participant_answers", {
          error: { code: "23505", message: "duplicate key" },
        });

      const promise = service.submitAnswer({
        participantId: "p1",
        sessionId: "s1",
        questionId: "q1",
        answers: ["A"],
        receivedAtMs: new Date(START).getTime() + 5000,
      });

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      await expect(promise).rejects.toThrow(ANSWER_ALREADY_RECORDED);
      // Aucune mise à jour du score
      const updates = supabase
        .queriesFor("participants")
        .flatMap((q) => q.calls)
        .filter((c) => c.method === "update");
      expect(updates).toHaveLength(0);
    });
  });
});
