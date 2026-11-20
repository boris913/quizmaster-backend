import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { ParticipantService, QuestionForStats } from "./participant.service";

const options = [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }];

describe("ParticipantService : statistiques de fin de question (issue #6)", () => {
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

  /** Participants actifs renvoyés par la base, puis réponses à la question. */
  const mockData = (activeIds: string[], answers: unknown[]) => {
    supabase
      .mockResponse("participants", { data: activeIds.map((id) => ({ id })) })
      .mockResponse("participant_answers", { data: answers });
  };

  it("agrège une question à choix unique", async () => {
    const question: QuestionForStats = {
      id: "q1",
      options,
      correct_answers: ["B"],
    };
    mockData(
      ["p1", "p2", "p3", "p4"],
      [
        {
          participant_id: "p1",
          answers: ["B"],
          is_correct: true,
          status: "answered",
        },
        {
          participant_id: "p2",
          answers: ["B"],
          is_correct: true,
          status: "answered",
        },
        {
          participant_id: "p3",
          answers: ["A"],
          is_correct: false,
          status: "answered",
        },
        // p4 n'a pas répondu : ligne timeout
        {
          participant_id: "p4",
          answers: [],
          is_correct: false,
          status: "timeout",
        },
      ],
    );

    const stats = await service.computeQuestionStats("s1", question);

    expect(stats).toMatchObject({
      questionId: "q1",
      distribution: { A: 1, B: 2, C: 0, D: 0 },
      correctAnswers: ["B"],
      accuracy: 50,
      answeredCount: 3,
      totalParticipants: 4,
    });
    expect(stats.answersByParticipant.get("p3")).toEqual({
      answers: ["A"],
      isCorrect: false,
    });
    expect(stats.answersByParticipant.has("p4")).toBe(false);

    // Participants "disconnected" et "kicked" exclus côté requête
    const [participantsQuery] = supabase.queriesFor("participants");
    expect(participantsQuery.calls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["session_id", "s1"] },
        { method: "neq", args: ["status", "disconnected"] },
        { method: "neq", args: ["status", "kicked"] },
      ]),
    );
    const [answersQuery] = supabase.queriesFor("participant_answers");
    expect(answersQuery.calls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["session_id", "s1"] },
        { method: "eq", args: ["question_id", "q1"] },
      ]),
    );
  });

  it("agrège une question à choix multiple (chaque option cochée compte)", async () => {
    const question: QuestionForStats = {
      id: "q2",
      options,
      correct_answers: ["A", "C"],
    };
    mockData(
      ["p1", "p2", "p3"],
      [
        {
          participant_id: "p1",
          answers: ["A", "C"],
          is_correct: true,
          status: "answered",
        },
        {
          participant_id: "p2",
          answers: ["A", "B"],
          is_correct: false,
          status: "answered",
        },
        // Doublon d'option ignoré
        {
          participant_id: "p3",
          answers: ["C", "C"],
          is_correct: false,
          status: "answered",
        },
      ],
    );

    const stats = await service.computeQuestionStats("s1", question);

    expect(stats.distribution).toEqual({ A: 2, B: 1, C: 2, D: 0 });
    expect(stats.answeredCount).toBe(3);
    expect(stats.totalParticipants).toBe(3);
    expect(stats.accuracy).toBe(33);
  });

  it("gère une question sans aucune réponse", async () => {
    mockData(["p1", "p2"], []);

    const stats = await service.computeQuestionStats("s1", {
      id: "q3",
      options,
      correct_answers: ["D"],
    });

    expect(stats).toMatchObject({
      distribution: { A: 0, B: 0, C: 0, D: 0 },
      accuracy: 0,
      answeredCount: 0,
      totalParticipants: 2,
    });
    expect(stats.answersByParticipant.size).toBe(0);
  });

  it("gère une session sans participant actif (pas de division par zéro)", async () => {
    mockData([], []);

    const stats = await service.computeQuestionStats("s1", {
      id: "q3",
      options,
      correct_answers: ["D"],
    });

    expect(stats.accuracy).toBe(0);
    expect(stats.totalParticipants).toBe(0);
  });

  it("ignore la réponse d'un participant exclu (kicked)", async () => {
    // p3 a répondu puis a été exclu : il n'est plus dans les participants actifs
    mockData(
      ["p1", "p2"],
      [
        {
          participant_id: "p1",
          answers: ["B"],
          is_correct: true,
          status: "answered",
        },
        {
          participant_id: "p3",
          answers: ["A"],
          is_correct: false,
          status: "answered",
        },
      ],
    );

    const stats = await service.computeQuestionStats("s1", {
      id: "q1",
      options,
      correct_answers: ["B"],
    });

    expect(stats.distribution).toEqual({ A: 0, B: 1, C: 0, D: 0 });
    expect(stats.answeredCount).toBe(1);
    expect(stats.totalParticipants).toBe(2);
    expect(stats.accuracy).toBe(50);
    expect(stats.answersByParticipant.has("p3")).toBe(false);
  });

  describe("countActiveAnswers", () => {
    it("ne compte que les réponses des participants actifs", async () => {
      supabase
        .mockResponse("participants", { data: [{ id: "p1" }, { id: "p2" }] })
        .mockResponse("participant_answers", {
          data: [{ participant_id: "p1" }, { participant_id: "p-kicked" }],
        });

      await expect(service.countActiveAnswers("s1", "q1")).resolves.toEqual({
        answeredCount: 1,
        totalParticipants: 2,
      });
      const [participantsQuery] = supabase.queriesFor("participants");
      expect(participantsQuery.calls).toEqual(
        expect.arrayContaining([
          { method: "neq", args: ["status", "disconnected"] },
          { method: "neq", args: ["status", "kicked"] },
        ]),
      );
    });
  });
});
