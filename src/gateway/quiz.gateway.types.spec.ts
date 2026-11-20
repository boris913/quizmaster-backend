import { Logger } from "@nestjs/common";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { QuizGateway } from "./quiz.gateway";

const OWNER = "user-owner";
const SECRET_EXPLANATION = "EXPLICATION-SECRETE-7";

const baseQuestion = {
  id: "q1",
  text: "Énoncé",
  max_points: 100,
  timer_seconds: 20,
  order_index: 0,
  explanation: SECRET_EXPLANATION,
  image_url:
    "https://proj.supabase.co/storage/v1/object/public/question-images/quiz1/x.png",
};

/** Une question de chaque type, avec une bonne réponse reconnaissable. */
const QUESTIONS: Record<string, any> = {
  true_false: {
    ...baseQuestion,
    type: "true_false",
    options: [
      { id: "true", text: "Vrai" },
      { id: "false", text: "Faux" },
    ],
    correct_answers: ["false"],
  },
  ordering: {
    ...baseQuestion,
    type: "ordering",
    options: [
      { id: "A", text: "Deux" },
      { id: "B", text: "Trois" },
      { id: "C", text: "Un" },
      { id: "D", text: "Quatre" },
    ],
    correct_answers: ["C", "A", "B", "D"],
  },
  short_answer: {
    ...baseQuestion,
    type: "short_answer",
    options: [],
    correct_answers: ["VARIANTE-SECRETE", "Autre-Secret"],
  },
  poll: {
    ...baseQuestion,
    type: "poll",
    options: [
      { id: "A", text: "Oui" },
      { id: "B", text: "Non" },
    ],
    correct_answers: [],
  },
  single: {
    ...baseQuestion,
    type: "single",
    options: [
      { id: "A", text: "Lyon" },
      { id: "B", text: "Paris" },
    ],
    correct_answers: ["B"],
  },
};

/** Vrai si le payload porte une bonne réponse, une variante ou l'explication. */
function leaksAnswer(payload: unknown, question: any): boolean {
  const json = JSON.stringify(payload ?? null);
  if (json.includes(SECRET_EXPLANATION)) return true;
  if (
    question.type === "short_answer" &&
    question.correct_answers.some((v: string) => json.includes(v))
  )
    return true;
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

interface Emission {
  target: string;
  event: string;
  payload: any;
}

describe("QuizGateway : types de question (issue #7)", () => {
  let gateway: QuizGateway;
  let supabase: SupabaseMock;
  let participantService: Record<string, jest.Mock>;
  let emissions: Emission[];
  let creator: any;
  let player: any;

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
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: OWNER, pseudo: "u" }),
    };
    const sessionService = {
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
      assertParticipantCanJoin: jest.fn().mockResolvedValue({}),
    };
    participantService = {
      submitAnswer: jest.fn().mockResolvedValue({
        isCorrect: false,
        pointsEarned: 0,
        timeTakenMs: 1000,
        correctAnswers: ["SECRET"],
        totalScore: 0,
        rank: 1,
        gapToNext: null,
        gapToPodium: null,
        onPodium: true,
      }),
      processTimeouts: jest.fn().mockResolvedValue(undefined),
      buildSessionLeaderboard: jest.fn().mockResolvedValue([]),
      computeQuestionStats: jest.fn(),
      countActiveAnswers: jest
        .fn()
        .mockResolvedValue({ answeredCount: 0, totalParticipants: 2 }),
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
    player = makeClient("sock-p1");
    gateway.server = {
      to: jest.fn((room: string) => ({
        emit: (event: string, payload: unknown) =>
          emissions.push({ target: room, event, payload }),
      })),
      in: jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue([creator, player]),
      })),
    } as any;

    supabase.mockResponse("sessions", {
      data: { creator_id: OWNER, status: "waiting" },
    });
    await gateway.handleCreatorJoin(creator, { sessionId: "s1", token: "jwt" });
    supabase
      .mockResponse("participants", { data: null })
      .mockResponse("participants", {
        data: { id: "p1", pseudo: "p1", score: 0, status: "waiting" },
      })
      .mockResponse("participants", { count: 1 });
    await gateway.handleParticipantJoin(player, {
      sessionId: "s1",
      participantId: "p1",
      role: "participant",
    });
    emissions = [];
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const start = async (question: any) => {
    supabase.mockResponse("questions", { data: [question] });
    await gateway.handleStartQuestion(creator, {
      sessionId: "s1",
      questionIndex: 0,
    });
  };

  it.each(Object.keys(QUESTIONS))(
    "%s : aucune bonne réponse vers les joueurs avant la clôture",
    async (type) => {
      const question = QUESTIONS[type];
      await start(question);
      await gateway.handleSubmitAnswer(player, {
        sessionId: "s1",
        participantId: "p1",
        questionId: "q1",
        answers: type === "short_answer" ? ["essai"] : ["A"],
      });

      const [startEvent] = emitted("question:start");
      expect(startEvent.payload.question.type).toBe(type);
      expect(startEvent.payload.question.image_url).toBe(
        baseQuestion.image_url,
      );
      expect(Object.keys(startEvent.payload.question).sort()).toEqual(
        [
          "id",
          "image_url",
          "max_points",
          "options",
          "order_index",
          "text",
          "timer_seconds",
          "type",
        ].sort(),
      );

      const toPlayers = emissions.filter((e) => e.target !== "creator:s1");
      expect(toPlayers.length).toBeGreaterThan(0);
      for (const e of toPlayers) {
        expect({
          event: e.event,
          leaks: leaksAnswer(e.payload, question),
        }).toEqual({ event: e.event, leaks: false });
      }
    },
  );

  it("short_answer : aucune option envoyée", async () => {
    await start(QUESTIONS.short_answer);
    expect(emitted("question:start")[0].payload.question.options).toEqual([]);
  });

  it("true_false et poll : options envoyées telles quelles", async () => {
    await start(QUESTIONS.true_false);
    expect(emitted("question:start")[0].payload.question.options).toEqual(
      QUESTIONS.true_false.options,
    );
  });

  it("ordering : options mélangées, jamais dans l'ordre attendu", async () => {
    const orders = new Set<string>();
    for (let i = 0; i < 30; i++) {
      emissions = [];
      await start(QUESTIONS.ordering);
      const ids = emitted("question:start")[0].payload.question.options.map(
        (o: any) => o.id,
      );
      expect(ids.join("")).not.toBe("CABD");
      expect([...ids].sort()).toEqual(["A", "B", "C", "D"]);
      orders.add(ids.join(""));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it("question sans image : image_url null", async () => {
    await start({ ...QUESTIONS.single, image_url: undefined });
    expect(emitted("question:start")[0].payload.question.image_url).toBeNull();
  });

  it("poll : stats non notées et reveal isCorrect=false", async () => {
    participantService.computeQuestionStats.mockResolvedValue({
      questionId: "q1",
      type: "poll",
      distribution: { A: 1, B: 0 },
      correctAnswers: [],
      accuracy: 0,
      graded: false,
      answeredCount: 1,
      totalParticipants: 1,
      answersByParticipant: new Map([
        ["p1", { answers: ["A"], isCorrect: true }],
      ]),
    });
    await start(QUESTIONS.poll);
    await jest.advanceTimersByTimeAsync(20_000);

    expect(participantService.computeQuestionStats).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "poll" }),
    );
    expect(emitted("question:stats")[0].payload).toEqual({
      questionId: "q1",
      type: "poll",
      distribution: { A: 1, B: 0 },
      correctAnswers: [],
      accuracy: 0,
      graded: false,
      answeredCount: 1,
      totalParticipants: 1,
    });
    expect(emitted("question:reveal")[0].payload).toMatchObject({
      type: "poll",
      graded: false,
      correctAnswers: [],
      yourAnswers: ["A"],
      isCorrect: false,
    });
  });

  it("short_answer : stats par réponse normalisée et variantes révélées à la clôture", async () => {
    participantService.computeQuestionStats.mockResolvedValue({
      questionId: "q1",
      type: "short_answer",
      distribution: { essai: 1 },
      correctAnswers: QUESTIONS.short_answer.correct_answers,
      accuracy: 0,
      graded: true,
      answeredCount: 1,
      totalParticipants: 1,
      answersByParticipant: new Map([
        ["p1", { answers: ["essai"], isCorrect: false }],
      ]),
    });
    await start(QUESTIONS.short_answer);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(emitted("question:stats")[0].payload).toMatchObject({
      type: "short_answer",
      distribution: { essai: 1 },
      graded: true,
    });
    expect(emitted("question:reveal")[0].payload).toMatchObject({
      type: "short_answer",
      graded: true,
      correctAnswers: ["VARIANTE-SECRETE", "Autre-Secret"],
      explanation: SECRET_EXPLANATION,
    });
  });
});
