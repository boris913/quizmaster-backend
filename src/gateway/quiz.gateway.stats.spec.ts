import { Logger } from "@nestjs/common";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { QuizGateway } from "./quiz.gateway";

const OWNER = "user-owner";
const SECRET_EXPLANATION = "EXPLICATION-SECRETE-42";

const question = {
  id: "q1",
  text: "Capitale de la France ?",
  type: "single",
  options: [
    { id: "A", text: "Lyon" },
    { id: "B", text: "Paris" },
    { id: "C", text: "Nice" },
  ],
  correct_answers: ["B"],
  explanation: SECRET_EXPLANATION,
  max_points: 100,
  timer_seconds: 20,
  order_index: 0,
};

const statsResult = {
  questionId: "q1",
  distribution: { A: 1, B: 1, C: 0 },
  correctAnswers: ["B"],
  accuracy: 50,
  answeredCount: 2,
  totalParticipants: 2,
  answersByParticipant: new Map([
    ["p1", { answers: ["B"], isCorrect: true }],
    ["p2", { answers: ["A"], isCorrect: false }],
  ]),
};

interface Emission {
  target: string;
  event: string;
  payload: any;
}

/**
 * Vrai si le payload contient la bonne réponse ou l'explication : clé
 * `correct_answers`/`correctAnswers` non vide, clé `explanation`, ou texte de
 * l'explication n'importe où.
 */
function leaksAnswer(payload: unknown): boolean {
  if (JSON.stringify(payload ?? null).includes(SECRET_EXPLANATION)) return true;
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (value && typeof value === "object") {
      return Object.entries(value).some(([key, v]) => {
        if (/^correct_?answers$/i.test(key) && Array.isArray(v) && v.length)
          return true;
        if (key === "explanation") return true;
        return visit(v);
      });
    }
    return false;
  };
  return visit(payload);
}

describe("QuizGateway : clôture de question, stats et anti-triche (issue #6)", () => {
  let gateway: QuizGateway;
  let supabase: SupabaseMock;
  let sessionService: Record<string, jest.Mock>;
  let participantService: Record<string, jest.Mock>;
  let jwtService: { verifyAsync: jest.Mock };
  let emissions: Emission[];
  let creator: any;
  let player1: any;
  let player2: any;

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

  const creatorJoin = async (client: any) => {
    jwtService.verifyAsync.mockResolvedValueOnce({ sub: OWNER, pseudo: "u" });
    supabase.mockResponse("sessions", {
      data: { creator_id: OWNER, status: "waiting" },
    });
    await gateway.handleCreatorJoin(client, {
      sessionId: "s1",
      token: "jwt",
    });
  };

  const participantJoin = async (client: any, id: string) => {
    supabase
      .mockResponse("participants", { data: null })
      .mockResponse("participants", {
        data: { id, pseudo: id, score: 0, status: "waiting" },
      })
      .mockResponse("participants", { count: 2 });
    await gateway.handleParticipantJoin(client, {
      sessionId: "s1",
      participantId: id,
      role: "participant",
    });
  };

  const startQuestion = async () => {
    supabase.mockResponse("questions", { data: [question] });
    await gateway.handleStartQuestion(creator, {
      sessionId: "s1",
      questionIndex: 0,
    });
  };

  const submit = (client: any, participantId: string, answers: string[]) =>
    gateway.handleSubmitAnswer(client, {
      sessionId: "s1",
      participantId,
      questionId: "q1",
      answers,
    });

  const emitted = (event: string) => emissions.filter((e) => e.event === event);

  beforeAll(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    jest.useFakeTimers();
    emissions = [];
    supabase = createSupabaseMock();
    jwtService = { verifyAsync: jest.fn() };
    sessionService = {
      getSessionParticipants: jest.fn().mockResolvedValue([]),
      getSessionLeaderboard: jest.fn().mockResolvedValue([]),
      getSessionWithDetails: jest.fn().mockResolvedValue({
        quiz_id: "quiz1",
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
        pointsEarned: 90,
        timeTakenMs: 1000,
        correctAnswers: ["B"],
        totalScore: 90,
        rank: 1,
        gapToNext: null,
        gapToPodium: null,
        onPodium: true,
      }),
      processTimeouts: jest.fn().mockResolvedValue(undefined),
      buildSessionLeaderboard: jest.fn().mockResolvedValue([]),
      computeQuestionStats: jest.fn().mockResolvedValue(statsResult),
      countActiveAnswers: jest
        .fn()
        .mockResolvedValue({ answeredCount: 1, totalParticipants: 2 }),
    };

    gateway = new QuizGateway(
      jwtService as any,
      { get: jest.fn().mockReturnValue("secret") } as any,
      sessionService as any,
      participantService as any,
      supabase.client,
    );
    // Compte à rebours instantané
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

    await creatorJoin(creator);
    await participantJoin(player1, "p1");
    await participantJoin(player2, "p2");
    emissions = [];
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("question:start n'envoie ni la bonne réponse ni l'explication", async () => {
    await startQuestion();

    const [start] = emitted("question:start");
    expect(start.target).toBe("session:s1");
    expect(start.payload.question).toEqual({
      id: "q1",
      text: question.text,
      type: "single",
      options: question.options,
      max_points: 100,
      timer_seconds: 20,
      order_index: 0,
    });
    expect(leaksAnswer(start.payload)).toBe(false);
  });

  it("aucune fuite vers les joueurs avant la clôture (start, réponse, progression)", async () => {
    await startQuestion();
    await submit(player1, "p1", ["B"]);

    // Question toujours ouverte (p2 n'a pas répondu)
    expect(emitted("question:reveal")).toHaveLength(0);
    expect(emitted("question:ended")).toHaveLength(0);

    const toPlayers = emissions.filter((e) => e.target !== "creator:s1");
    expect(toPlayers.length).toBeGreaterThan(0);
    for (const e of toPlayers) {
      expect({ event: e.event, leaks: leaksAnswer(e.payload) }).toEqual({
        event: e.event,
        leaks: false,
      });
    }
    // Le résultat individuel garde sa forme, sans la bonne réponse
    const [result] = emitted("answer:result");
    expect(result.target).toBe("socket:sock-p1");
    expect(result.payload.correct_answers).toEqual([]);
  });

  it("au timeout : question:stats (créateur) et question:reveal (joueurs) une seule fois", async () => {
    await startQuestion();
    await jest.advanceTimersByTimeAsync(20_000);

    expect(participantService.processTimeouts).toHaveBeenCalledTimes(1);
    expect(participantService.computeQuestionStats).toHaveBeenCalledWith("s1", {
      id: "q1",
      options: question.options,
      correct_answers: ["B"],
    });

    const stats = emitted("question:stats");
    expect(stats).toEqual([
      {
        target: "creator:s1",
        event: "question:stats",
        payload: {
          questionId: "q1",
          distribution: { A: 1, B: 1, C: 0 },
          correctAnswers: ["B"],
          accuracy: 50,
          answeredCount: 2,
          totalParticipants: 2,
        },
      },
    ]);

    const reveals = emitted("question:reveal");
    expect(reveals).toEqual([
      {
        target: "socket:sock-p1",
        event: "question:reveal",
        payload: {
          questionId: "q1",
          correctAnswers: ["B"],
          explanation: SECRET_EXPLANATION,
          yourAnswers: ["B"],
          isCorrect: true,
        },
      },
      {
        target: "socket:sock-p2",
        event: "question:reveal",
        payload: {
          questionId: "q1",
          correctAnswers: ["B"],
          explanation: SECRET_EXPLANATION,
          yourAnswers: ["A"],
          isCorrect: false,
        },
      },
    ]);
    // Le créateur ne reçoit pas de reveal individuel
    expect(creator.emit).not.toHaveBeenCalledWith(
      "question:reveal",
      expect.anything(),
    );

    // Une seconde clôture (timer rejoué, appel tardif) ne réémet rien
    await jest.advanceTimersByTimeAsync(60_000);
    await expect(gateway.closeQuestion("s1", "q1", "timeout")).resolves.toBe(
      false,
    );
    expect(emitted("question:stats")).toHaveLength(1);
    expect(emitted("question:reveal")).toHaveLength(2);
    expect(emitted("question:ended")).toHaveLength(1);
  });

  it("clôture anticipée quand tous les participants actifs ont répondu, sans second envoi au timeout", async () => {
    await startQuestion();

    participantService.countActiveAnswers.mockResolvedValueOnce({
      answeredCount: 1,
      totalParticipants: 2,
    });
    await submit(player1, "p1", ["B"]);
    expect(emitted("question:stats")).toHaveLength(0);

    participantService.countActiveAnswers.mockResolvedValueOnce({
      answeredCount: 2,
      totalParticipants: 2,
    });
    await submit(player2, "p2", ["A"]);

    expect(emitted("question:stats")).toHaveLength(1);
    expect(emitted("question:reveal")).toHaveLength(2);

    // Le timer a été annulé : rien de plus à l'échéance
    await jest.advanceTimersByTimeAsync(30_000);
    expect(emitted("question:stats")).toHaveLength(1);
    expect(emitted("question:reveal")).toHaveLength(2);
    expect(participantService.processTimeouts).toHaveBeenCalledTimes(1);

    // Une réponse tardive est refusée
    await submit(player2, "p2", ["C"]);
    expect(player2.emit).toHaveBeenCalledWith(
      "answer:too_late",
      expect.anything(),
    );
  });

  it("deux dernières réponses simultanées : une seule émission", async () => {
    await startQuestion();
    participantService.countActiveAnswers.mockResolvedValue({
      answeredCount: 2,
      totalParticipants: 2,
    });

    await Promise.all([
      submit(player1, "p1", ["B"]),
      submit(player2, "p2", ["A"]),
    ]);

    expect(emitted("question:stats")).toHaveLength(1);
    expect(emitted("question:reveal")).toHaveLength(2);
  });

  it("l'exclusion du dernier joueur sans réponse clôture la question", async () => {
    await startQuestion();
    participantService.countActiveAnswers.mockResolvedValueOnce({
      answeredCount: 1,
      totalParticipants: 1,
    });

    await gateway.handleCreatorKick(creator, {
      sessionId: "s1",
      participantId: "p2",
    });

    expect(emitted("question:stats")).toHaveLength(1);
  });
});

describe("QuizGateway : quiz:finished vers la room créateur", () => {
  it("quiz:end envoie quiz:finished au créateur et aux joueurs", async () => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const supabase = createSupabaseMock();
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: OWNER, pseudo: "u" }),
    };
    const sessionService = {
      getSessionParticipants: jest.fn().mockResolvedValue([]),
      getSessionLeaderboard: jest.fn().mockResolvedValue([]),
      updateSessionStatus: jest.fn().mockResolvedValue({}),
      assertParticipantCanJoin: jest.fn().mockResolvedValue({}),
    };
    const gateway = new QuizGateway(
      jwtService as any,
      { get: jest.fn().mockReturnValue("secret") } as any,
      sessionService as any,
      {} as any,
      supabase.client,
    );
    const roomEmits: Emission[] = [];
    const creator: any = { id: "c", join: jest.fn(), emit: jest.fn() };
    const player: any = { id: "p", join: jest.fn(), emit: jest.fn() };
    gateway.server = {
      to: jest.fn((room: string) => ({
        emit: (event: string, payload: unknown) =>
          roomEmits.push({ target: room, event, payload }),
      })),
      in: jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue([creator, player]),
      })),
    } as any;

    supabase.mockResponse("sessions", {
      data: { creator_id: OWNER, status: "active" },
    });
    await gateway.handleCreatorJoin(creator, { sessionId: "s1", token: "t" });
    supabase
      .mockResponse("participants", { data: null })
      .mockResponse("participants", {
        data: { id: "p1", pseudo: "Alice", score: 0, status: "waiting" },
      })
      .mockResponse("participants", { count: 1 });
    await gateway.handleParticipantJoin(player, {
      sessionId: "s1",
      participantId: "p1",
      role: "participant",
    });

    supabase.mockResponse("participants", {
      data: [{ id: "p1", pseudo: "Alice", score: 300 }],
    });
    await gateway.handleEndQuiz(creator, { sessionId: "s1" });

    const toCreator = roomEmits.filter(
      (e) => e.target === "creator:s1" && e.event === "quiz:finished",
    );
    expect(toCreator).toHaveLength(1);
    expect(toCreator[0].payload).toEqual({
      final_leaderboard: [
        expect.objectContaining({
          rank: 1,
          participant_id: "p1",
          pseudo: "Alice",
          score: 300,
        }),
      ],
      winner_pseudo: "Alice",
      total_participants: 1,
      total_questions: 1,
    });

    // Le joueur garde son message personnalisé ; le socket créateur ne le
    // reçoit pas en double
    expect(player.emit).toHaveBeenCalledWith(
      "quiz:finished",
      expect.objectContaining({ your_rank: 1, is_winner: true }),
    );
    expect(creator.emit).not.toHaveBeenCalledWith(
      "quiz:finished",
      expect.anything(),
    );
  });
});
