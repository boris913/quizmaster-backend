import { Logger } from "@nestjs/common";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { QuizGateway } from "./quiz.gateway";

const OWNER = "user-owner";
const OTHER = "user-other";

describe("QuizGateway : événements créateur", () => {
  let gateway: QuizGateway;
  let supabase: SupabaseMock;
  let sessionService: Record<string, jest.Mock>;
  let jwtService: { verifyAsync: jest.Mock };
  let emit: jest.Mock;

  const makeClient = (id: string) =>
    ({
      id,
      join: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn(),
    }) as any;

  /** Simule "creator:join" avec un JWT valide pour `userId`. */
  const creatorJoin = async (
    client: any,
    sessionId: string,
    userId: string,
  ) => {
    jwtService.verifyAsync.mockResolvedValueOnce({ sub: userId, pseudo: "u" });
    supabase.mockResponse("sessions", {
      data: { creator_id: OWNER, status: "waiting" },
    });
    await gateway.handleCreatorJoin(client, { sessionId, token: "jwt" });
  };

  beforeAll(() => {
    // Journaux du gateway inutiles dans la sortie des tests
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
      updateSessionStatus: jest.fn().mockResolvedValue({}),
    };
    const configService = { get: jest.fn().mockReturnValue("secret") };

    gateway = new QuizGateway(
      jwtService as any,
      configService as any,
      sessionService as any,
      {} as any,
      supabase.client,
    );
    emit = jest.fn();
    gateway.server = {
      to: jest.fn(() => ({ emit })),
      in: jest.fn(() => ({ fetchSockets: jest.fn().mockResolvedValue([]) })),
    } as any;
  });

  it("creator:join refuse un utilisateur qui n'est pas propriétaire", async () => {
    const client = makeClient("sock1");
    await creatorJoin(client, "s1", OTHER);

    expect(client.emit).toHaveBeenCalledWith("error", {
      message: "Authentification échouée",
    });
    expect(client.join).not.toHaveBeenCalled();
    expect(gateway.isCreatorOfSession(client, "s1")).toBe(false);
  });

  it("creator:join accepte le propriétaire de la session", async () => {
    const client = makeClient("sock1");
    await creatorJoin(client, "s1", OWNER);

    expect(client.emit).toHaveBeenCalledWith(
      "creator:join:success",
      expect.objectContaining({ session_id: "s1" }),
    );
    expect(gateway.isCreatorOfSession(client, "s1")).toBe(true);
  });

  describe("session:pause / session:resume", () => {
    it("sont ignorés pour un socket non authentifié comme créateur", async () => {
      const client = makeClient("sock1");
      await gateway.handlePauseSession(client, { sessionId: "s1" });
      await gateway.handleResumeSession(client, { sessionId: "s1" });

      expect(sessionService.updateSessionStatus).not.toHaveBeenCalled();
    });

    it("sont ignorés pour une autre session que celle du créateur", async () => {
      const client = makeClient("sock1");
      await creatorJoin(client, "s1", OWNER);

      await gateway.handlePauseSession(client, { sessionId: "s2" });
      await gateway.handleResumeSession(client, { sessionId: "s2" });

      expect(sessionService.updateSessionStatus).not.toHaveBeenCalled();
    });

    it("sont appliqués pour la session du créateur", async () => {
      const client = makeClient("sock1");
      await creatorJoin(client, "s1", OWNER);

      await gateway.handlePauseSession(client, { sessionId: "s1" });
      await gateway.handleResumeSession(client, { sessionId: "s1" });

      expect(sessionService.updateSessionStatus.mock.calls).toEqual([
        ["s1", "paused"],
        ["s1", "active"],
      ]);
    });
  });

  it("question:start est refusé pour une autre session que celle du créateur", async () => {
    const client = makeClient("sock1");
    await creatorJoin(client, "s1", OWNER);

    await gateway.handleStartQuestion(client, {
      sessionId: "s2",
      questionIndex: 0,
    });

    expect(client.emit).toHaveBeenCalledWith("error", {
      message: "Seul le créateur peut lancer une question",
    });
    expect(sessionService.getSessionWithDetails).not.toHaveBeenCalled();
    expect(sessionService.setCurrentQuestion).not.toHaveBeenCalled();
  });

  it("quiz:end est refusé pour une autre session que celle du créateur", async () => {
    const client = makeClient("sock1");
    await creatorJoin(client, "s1", OWNER);

    await gateway.handleEndQuiz(client, { sessionId: "s2" });

    expect(client.emit).toHaveBeenCalledWith("error", {
      message: "Seul le créateur peut terminer le quiz",
    });
    expect(sessionService.updateSessionStatus).not.toHaveBeenCalled();
  });

  it("quiz:end est appliqué pour la session du créateur", async () => {
    const client = makeClient("sock1");
    await creatorJoin(client, "s1", OWNER);
    supabase.mockResponse("participants", { data: [] });

    await gateway.handleEndQuiz(client, { sessionId: "s1" });

    expect(sessionService.updateSessionStatus).toHaveBeenCalledWith(
      "s1",
      "finished",
    );
  });
});
