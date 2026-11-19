import { ForbiddenException, Logger } from "@nestjs/common";
import { NICKNAME_ERRORS } from "../common/utils/nickname.util";
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
      disconnect: jest.fn(),
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
      assertParticipantCanJoin: jest.fn().mockResolvedValue({}),
      kickParticipant: jest.fn().mockResolvedValue({}),
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

  describe("creator:kick (issue #5)", () => {
    /** Simule un participant connecté via "participant:join". */
    const participantJoin = async (client: any, sessionId: string, id: string) => {
      supabase
        .mockResponse("participants", { data: null }) // update socket_id
        .mockResponse("participants", {
          data: { id, pseudo: "Toto", score: 0, status: "waiting" },
        })
        .mockResponse("participants", { count: 1 });
      await gateway.handleParticipantJoin(client, {
        sessionId,
        participantId: id,
        role: "participant",
      });
    };

    const mockRoomSockets = (sockets: any[]) => {
      (gateway.server as any).in = jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue(sockets),
      }));
    };

    it("est refusé pour un socket qui n'est pas créateur", async () => {
      const player = makeClient("sock-player");
      await participantJoin(player, "s1", "p1");

      await gateway.handleCreatorKick(player, {
        sessionId: "s1",
        participantId: "p1",
      });

      expect(player.emit).toHaveBeenCalledWith("error", {
        message: "Seul le créateur peut exclure un participant",
      });
      expect(sessionService.kickParticipant).not.toHaveBeenCalled();
      expect(player.disconnect).not.toHaveBeenCalled();
    });

    it("est refusé pour une autre session que celle du créateur", async () => {
      const creator = makeClient("sock-creator");
      await creatorJoin(creator, "s1", OWNER);

      await gateway.handleCreatorKick(creator, {
        sessionId: "s2",
        participantId: "p1",
      });

      expect(creator.emit).toHaveBeenCalledWith("error", {
        message: "Seul le créateur peut exclure un participant",
      });
      expect(sessionService.kickParticipant).not.toHaveBeenCalled();
    });

    it("exclut le participant : statut kicked, notification, déconnexion", async () => {
      const creator = makeClient("sock-creator");
      await creatorJoin(creator, "s1", OWNER);
      const player = makeClient("sock-player");
      await participantJoin(player, "s1", "p1");
      const other = makeClient("sock-other");
      await participantJoin(other, "s1", "p2");
      mockRoomSockets([creator, player, other]);
      emit.mockClear();

      await gateway.handleCreatorKick(creator, {
        sessionId: "s1",
        participantId: "p1",
      });

      expect(sessionService.kickParticipant).toHaveBeenCalledWith("s1", "p1");
      expect(player.emit).toHaveBeenCalledWith("participant:kicked", {
        reason: "kicked",
      });
      expect(player.disconnect).toHaveBeenCalledWith(true);
      expect(other.emit).not.toHaveBeenCalledWith(
        "participant:kicked",
        expect.anything(),
      );
      expect(other.disconnect).not.toHaveBeenCalled();
      expect(gateway.server.to).toHaveBeenCalledWith("creator:s1");
      expect(emit).toHaveBeenCalledWith("participant:disconnected", {
        participant_id: "p1",
        reason: "kicked",
      });

      // La déconnexion qui suit ne repasse pas le participant en "disconnected"
      supabase.reset();
      await gateway.handleDisconnect(player);
      expect(supabase.queriesFor("participants")).toHaveLength(0);
    });

    it("refuse la reconnexion d'un participant exclu (participant:join)", async () => {
      sessionService.assertParticipantCanJoin.mockRejectedValueOnce(
        new ForbiddenException(NICKNAME_ERRORS.kicked),
      );
      const player = makeClient("sock-player-2");

      await gateway.handleParticipantJoin(player, {
        sessionId: "s1",
        participantId: "p1",
        role: "participant",
      });

      expect(player.join).not.toHaveBeenCalled();
      expect(player.emit).toHaveBeenCalledWith("participant:kicked", {
        reason: "kicked",
      });
      expect(player.disconnect).toHaveBeenCalledWith(true);
      expect(supabase.queriesFor("participants")).toHaveLength(0);
    });

    it("participant:join renvoie une erreur claire pour un pseudo interdit", async () => {
      sessionService.assertParticipantCanJoin.mockRejectedValueOnce(
        new Error(NICKNAME_ERRORS.notAllowed),
      );
      const player = makeClient("sock-player-3");

      await gateway.handleParticipantJoin(player, {
        sessionId: "s1",
        participantId: "p1",
        role: "participant",
      });

      expect(player.join).not.toHaveBeenCalled();
      expect(player.emit).toHaveBeenCalledWith("error", {
        message: NICKNAME_ERRORS.notAllowed,
      });
      expect(player.disconnect).not.toHaveBeenCalled();
    });
  });
});
