import { Logger } from "@nestjs/common";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { QuizGateway } from "./quiz.gateway";

const OWNER = "user-owner";

const question = {
  id: "q1",
  text: "Capitale de la France ?",
  type: "single",
  options: [
    { id: "A", text: "Lyon" },
    { id: "B", text: "Paris" },
  ],
  correct_answers: ["B"],
  explanation: null,
  max_points: 100,
  timer_seconds: 20,
  order_index: 0,
};

const leaderboard = [
  {
    rank: 1,
    participant_id: "p1",
    pseudo: "Alice",
    score: 100,
    last_points: 100,
    answered_current: true,
    gap_to_next: null,
    gap_to_podium: null,
    on_podium: true,
  },
  {
    rank: 2,
    participant_id: "p2",
    pseudo: "Bob",
    score: 0,
    last_points: 0,
    answered_current: true,
    gap_to_next: 100,
    gap_to_podium: null,
    on_podium: true,
  },
];

interface Emission {
  target: string;
  event: string;
  payload: any;
}

/** Clés qui révèlent un classement, un rang ou une position relative. */
const RANK_KEYS =
  /^(rank|your_rank|gap_to_next|gap_to_podium|on_podium|leaderboard|final_leaderboard|is_winner|winner_pseudo)$/;

/**
 * Chemins des clés de classement présentes dans le payload, et présence du
 * pseudo ou du score d'un autre joueur.
 */
function rankLeaks(payload: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${path}[${i}]`));
    } else if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        if (RANK_KEYS.test(key)) found.push(`${path}.${key}`);
        visit(v, `${path}.${key}`);
      }
    }
  };
  visit(payload, "$");
  return found;
}

describe("QuizGateway : classement masqué (issue #8)", () => {
  let gateway: QuizGateway;
  let supabase: SupabaseMock;
  let sessionService: Record<string, jest.Mock>;
  let participantService: Record<string, jest.Mock>;
  let jwtService: { verifyAsync: jest.Mock };
  let emissions: Emission[];
  let creator: any;
  let player1: any;
  let player2: any;
  let showLeaderboard: boolean;

  const makeClient = (id: string) => {
    const client: any = {
      id,
      join: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };
    client.emit = jest.fn((event: string, payload: unknown) =>
      emissions.push({ target: `socket:${id}`, event, payload }),
    );
    return client;
  };

  const participantJoin = async (client: any, id: string, score = 0) => {
    supabase
      .mockResponse("participants", { data: null })
      .mockResponse("participants", {
        data: { id, pseudo: `pseudo-${id}`, score, status: "waiting" },
      })
      .mockResponse("participants", { count: 2 })
      .mockResponse("sessions", {
        data: { show_leaderboard: showLeaderboard },
      });
    await gateway.handleParticipantJoin(client, {
      sessionId: "s1",
      participantId: id,
      role: "participant",
    });
  };

  const submit = (client: any, participantId: string, answers: string[]) =>
    gateway.handleSubmitAnswer(client, {
      sessionId: "s1",
      participantId,
      questionId: "q1",
      answers,
    });

  /** Partie complète : 2 joueurs rejoignent, 1 question, fin du quiz. */
  const playFullGame = async () => {
    await participantJoin(player1, "p1");
    await participantJoin(player2, "p2", 40); // reconnexion en cours de partie

    supabase.mockResponse("questions", { data: [question] });
    await gateway.handleStartQuestion(creator, {
      sessionId: "s1",
      questionIndex: 0,
    });

    participantService.countActiveAnswers
      .mockResolvedValueOnce({ answeredCount: 1, totalParticipants: 2 })
      .mockResolvedValueOnce({ answeredCount: 2, totalParticipants: 2 });
    await submit(player1, "p1", ["B"]);
    await submit(player2, "p2", ["A"]);

    supabase
      .mockResponse("participants", {
        data: [
          { id: "p1", pseudo: "Alice", score: 100 },
          { id: "p2", pseudo: "Bob", score: 0 },
        ],
      })
      .mockResponse("sessions", {
        data: { show_leaderboard: showLeaderboard },
      });
    await gateway.handleEndQuiz(creator, { sessionId: "s1" });
  };

  // Tout ce qui atteint un joueur : room session (joueurs + créateur) et
  // sockets joueurs. La room et le socket créateur sont exclus.
  const toPlayers = () =>
    emissions.filter(
      (e) => e.target !== "creator:s1" && e.target !== "socket:sock-creator",
    );
  const toCreator = (event: string) =>
    emissions.filter((e) => e.target === "creator:s1" && e.event === event);
  const forSocket = (sock: string, event: string) =>
    emissions.filter((e) => e.target === `socket:${sock}` && e.event === event);

  beforeAll(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  const setup = async (show: boolean) => {
    showLeaderboard = show;
    emissions = [];
    supabase = createSupabaseMock();
    jwtService = { verifyAsync: jest.fn() };
    sessionService = {
      getSessionParticipants: jest.fn().mockResolvedValue([]),
      getSessionLeaderboard: jest.fn().mockResolvedValue(leaderboard),
      getSessionWithDetails: jest.fn().mockResolvedValue({
        quiz_id: "quiz1",
        show_leaderboard: show,
        scoring_mode: "accuracy",
        quizzes: {
          id: "quiz1",
          use_global_timer: false,
          global_timer_seconds: 30,
        },
      }),
      setCurrentQuestion: jest.fn().mockResolvedValue(undefined),
      updateSessionStatus: jest.fn().mockResolvedValue({}),
      assertParticipantCanJoin: jest.fn().mockResolvedValue({}),
      kickParticipant: jest.fn().mockResolvedValue({}),
    };
    participantService = {
      submitAnswer: jest.fn().mockResolvedValue({
        isCorrect: true,
        pointsEarned: 100,
        timeTakenMs: 1000,
        correctAnswers: ["B"],
        totalScore: 100,
        rank: 1,
        gapToNext: null,
        gapToPodium: null,
        onPodium: true,
      }),
      processTimeouts: jest.fn().mockResolvedValue(undefined),
      buildSessionLeaderboard: jest.fn().mockResolvedValue(leaderboard),
      computeQuestionStats: jest.fn().mockResolvedValue({
        questionId: "q1",
        distribution: { A: 1, B: 1 },
        correctAnswers: ["B"],
        accuracy: 50,
        answeredCount: 2,
        totalParticipants: 2,
        answersByParticipant: new Map([
          ["p1", { answers: ["B"], isCorrect: true }],
          ["p2", { answers: ["A"], isCorrect: false }],
        ]),
      }),
      countActiveAnswers: jest.fn(),
      computeClassProgress: jest.fn().mockResolvedValue({
        classAccuracy: 50,
        participants: new Map([
          ["p1", { score: 100, correctCount: 1 }],
          ["p2", { score: 0, correctCount: 0 }],
        ]),
      }),
    };

    gateway = new QuizGateway(
      jwtService as any,
      { get: jest.fn().mockReturnValue("secret") } as any,
      sessionService as any,
      participantService as any,
      supabase.client,
    );
    jest.spyOn(gateway as any, "sendCountdown").mockResolvedValue(undefined);

    creator = makeClient("sock-creator");
    player1 = makeClient("sock-p1");
    player2 = makeClient("sock-p2");
    gateway.server = {
      to: jest.fn((room: string) => ({
        emit: (event: string, payload: unknown) =>
          emissions.push({ target: room, event, payload }),
      })),
      in: jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue([creator, player1, player2]),
      })),
    } as any;

    jwtService.verifyAsync.mockResolvedValueOnce({ sub: OWNER, pseudo: "u" });
    supabase.mockResponse("sessions", {
      data: { creator_id: OWNER, status: "waiting" },
    });
    await gateway.handleCreatorJoin(creator, {
      sessionId: "s1",
      token: "jwt",
    });
  };

  describe("show_leaderboard = false", () => {
    beforeEach(() => setup(false));

    it("aucun rang ni classement vers les joueurs, sur tous les événements", async () => {
      await playFullGame();

      const players = toPlayers();
      // La partie a bien produit des événements joueurs
      for (const event of [
        "participant:joined",
        "question:start",
        "answer:result",
        "question:ended",
        "question:reveal",
        "player:score",
        "quiz:finished",
      ]) {
        expect(players.some((e) => e.event === event)).toBe(true);
      }
      for (const e of players) {
        expect({ event: e.event, leaks: rankLeaks(e.payload) }).toEqual({
          event: e.event,
          leaks: [],
        });
      }
      // Rien de diffusé à toute la room session (qui contient les joueurs)
      // ne porte de score d'un autre joueur
      for (const e of players.filter((x) => x.target === "session:s1")) {
        expect(JSON.stringify(e.payload)).not.toMatch(/"score"/);
      }
    });

    it("answer:result sans rang, écarts ni podium", async () => {
      await playFullGame();
      const [result] = forSocket("sock-p1", "answer:result");
      expect(result.payload).toEqual({
        is_correct: true,
        points_earned: 100,
        max_points: "q1",
        time_taken_ms: 1000,
        correct_answers: [],
        your_answer: ["B"],
        total_score: 100,
        waiting_for_timer: true,
      });
    });

    it("participant:joined sans le score aux joueurs, complet au créateur", async () => {
      await playFullGame();
      const toP1 = forSocket("sock-p1", "participant:joined");
      expect(toP1.map((e) => e.payload)).toContainEqual({
        participant: { id: "p2", pseudo: "pseudo-p2", status: "waiting" },
        total_participants: 2,
      });
      expect(
        toCreator("participant:joined").map((e) => e.payload),
      ).toContainEqual({
        participant: {
          id: "p2",
          pseudo: "pseudo-p2",
          score: 40,
          status: "waiting",
        },
        total_participants: 2,
      });
      expect(
        emissions.filter(
          (e) => e.target === "session:s1" && e.event === "participant:joined",
        ),
      ).toHaveLength(0);
    });

    it("question:ended sans classement aux joueurs, avec classement au créateur", async () => {
      await playFullGame();
      for (const sock of ["sock-p1", "sock-p2"]) {
        expect(forSocket(sock, "question:ended").map((e) => e.payload)).toEqual(
          [{ question_id: "q1", correct_answers: ["B"] }],
        );
      }
      expect(toCreator("question:ended").map((e) => e.payload)).toEqual([
        { question_id: "q1", correct_answers: ["B"], leaderboard },
      ]);
      expect(creator.emit).not.toHaveBeenCalledWith(
        "question:ended",
        expect.anything(),
      );
    });

    it("player:score à chaque joueur à la clôture, jamais au créateur", async () => {
      await playFullGame();
      expect(
        forSocket("sock-p1", "player:score").map((e) => e.payload),
      ).toEqual([{ score: 100, correctCount: 1, classAccuracy: 50 }]);
      expect(
        forSocket("sock-p2", "player:score").map((e) => e.payload),
      ).toEqual([{ score: 0, correctCount: 0, classAccuracy: 50 }]);
      expect(toCreator("player:score")).toHaveLength(0);
      expect(creator.emit).not.toHaveBeenCalledWith(
        "player:score",
        expect.anything(),
      );
    });

    it("quiz:finished réduit à { classAccuracy, yourScore } pour les joueurs, complet pour le créateur", async () => {
      await playFullGame();
      expect(
        forSocket("sock-p1", "quiz:finished").map((e) => e.payload),
      ).toEqual([{ classAccuracy: 50, yourScore: 100 }]);
      expect(
        forSocket("sock-p2", "quiz:finished").map((e) => e.payload),
      ).toEqual([{ classAccuracy: 50, yourScore: 0 }]);
      const [finished] = toCreator("quiz:finished");
      expect(finished.payload).toEqual({
        final_leaderboard: [
          expect.objectContaining({
            rank: 1,
            participant_id: "p1",
            score: 100,
          }),
          expect.objectContaining({ rank: 2, participant_id: "p2", score: 0 }),
        ],
        winner_pseudo: "Alice",
        total_participants: 2,
        total_questions: 2,
      });
      expect(toCreator("quiz:finished")).toHaveLength(1);
      expect(creator.emit).not.toHaveBeenCalledWith(
        "quiz:finished",
        expect.anything(),
      );
    });

    it("le créateur garde question:stats et le classement à la connexion", async () => {
      await playFullGame();
      expect(toCreator("question:stats")).toHaveLength(1);
      expect(creator.emit).toHaveBeenCalledWith(
        "creator:join:success",
        expect.objectContaining({ leaderboard }),
      );
    });
  });

  describe("show_leaderboard = true (non-régression)", () => {
    beforeEach(() => setup(true));

    it("comportement inchangé : rang, classement et podium envoyés, pas de player:score", async () => {
      await playFullGame();

      const [result] = forSocket("sock-p1", "answer:result");
      expect(result.payload).toMatchObject({
        rank: 1,
        gap_to_next: null,
        gap_to_podium: null,
        on_podium: true,
        total_participants: 0,
      });

      expect(
        emissions.filter(
          (e) => e.target === "session:s1" && e.event === "question:ended",
        ),
      ).toEqual([
        {
          target: "session:s1",
          event: "question:ended",
          payload: { question_id: "q1", correct_answers: ["B"], leaderboard },
        },
      ]);
      expect(
        emissions.filter(
          (e) => e.target === "session:s1" && e.event === "participant:joined",
        ),
      ).toHaveLength(2);

      expect(emissions.some((e) => e.event === "player:score")).toBe(false);
      expect(participantService.computeClassProgress).not.toHaveBeenCalled();

      const [finished] = forSocket("sock-p1", "quiz:finished");
      expect(finished.payload).toMatchObject({
        your_rank: 1,
        your_score: 100,
        is_winner: true,
        winner_pseudo: "Alice",
      });
      expect(finished.payload.final_leaderboard).toHaveLength(2);
    });
  });
});
