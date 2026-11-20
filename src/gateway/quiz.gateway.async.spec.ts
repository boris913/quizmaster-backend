import { Logger } from "@nestjs/common";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { ASYNC_LIVE_FORBIDDEN } from "../session/session.service";
import { QuizGateway } from "./quiz.gateway";

const OWNER = "user-owner";

describe("QuizGateway : une session devoir ne se joue pas en direct (issue #10)", () => {
  let gateway: QuizGateway;
  let supabase: SupabaseMock;
  let sessionService: Record<string, jest.Mock>;
  let jwtService: { verifyAsync: jest.Mock };

  const makeClient = (id: string) =>
    ({
      id,
      join: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
      disconnect: jest.fn(),
    }) as any;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    supabase = createSupabaseMock();
    jwtService = { verifyAsync: jest.fn() };
    sessionService = {
      getSessionParticipants: jest.fn().mockResolvedValue([]),
      getSessionLeaderboard: jest.fn().mockResolvedValue([]),
      getSessionWithDetails: jest.fn(),
      setCurrentQuestion: jest.fn(),
      assertParticipantCanJoin: jest.fn(),
    };
    gateway = new QuizGateway(
      jwtService as any,
      { get: jest.fn().mockReturnValue("secret") } as any,
      sessionService as any,
      {} as any,
      supabase.client,
    );
    gateway.server = {
      to: jest.fn(() => ({ emit: jest.fn() })),
      in: jest.fn(() => ({ fetchSockets: jest.fn().mockResolvedValue([]) })),
    } as any;
  });

  const creatorJoin = async (client: any, mode: string) => {
    jwtService.verifyAsync.mockResolvedValueOnce({ sub: OWNER, pseudo: "u" });
    supabase.mockResponse("sessions", {
      data: { creator_id: OWNER, status: "active", mode },
    });
    await gateway.handleCreatorJoin(client, { sessionId: "s1", token: "jwt" });
  };

  it("creator:join refuse le pilotage d'un devoir, même par son créateur", async () => {
    const client = makeClient("sock1");
    await creatorJoin(client, "async");

    expect(client.emit).toHaveBeenCalledWith("error", {
      message: ASYNC_LIVE_FORBIDDEN,
      mode: "async",
    });
    expect(client.join).not.toHaveBeenCalled();
    expect(gateway.isCreatorOfSession(client, "s1")).toBe(false);
  });

  it("question:start est donc refusé pour un devoir", async () => {
    const client = makeClient("sock1");
    await creatorJoin(client, "async");

    await gateway.handleStartQuestion(client, {
      sessionId: "s1",
      questionIndex: 0,
    });

    expect(sessionService.getSessionWithDetails).not.toHaveBeenCalled();
    expect(sessionService.setCurrentQuestion).not.toHaveBeenCalled();
  });

  it("question:start refuse un devoir même pour un socket créateur (défense en profondeur)", async () => {
    const client = makeClient("sock1");
    await creatorJoin(client, "live");
    sessionService.getSessionWithDetails.mockResolvedValueOnce({
      id: "s1",
      mode: "async",
      quizzes: { id: "quiz1" },
    });

    await gateway.handleStartQuestion(client, {
      sessionId: "s1",
      questionIndex: 0,
    });

    expect(client.emit).toHaveBeenCalledWith("error", {
      message: ASYNC_LIVE_FORBIDDEN,
      mode: "async",
    });
    expect(supabase.queriesFor("questions")).toHaveLength(0);
    expect(sessionService.setCurrentQuestion).not.toHaveBeenCalled();
  });

  it("participant:join refuse un devoir sans rejoindre la room", async () => {
    const client = makeClient("sock2");
    sessionService.assertParticipantCanJoin.mockRejectedValueOnce(
      new Error(ASYNC_LIVE_FORBIDDEN),
    );

    await gateway.handleParticipantJoin(client, {
      sessionId: "s1",
      participantId: "p1",
      role: "participant",
    });

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith("error", {
      message: ASYNC_LIVE_FORBIDDEN,
      mode: "async",
    });
  });
});
