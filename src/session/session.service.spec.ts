import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { MAX_SESSION_CODE_ATTEMPTS, SessionService } from "./session.service";

const OWNER = "user-owner";
const OTHER = "user-other";

const session = {
  id: "s1",
  creator_id: OWNER,
  quiz_id: "quiz1",
  status: "active",
  quizzes: { id: "quiz1", title: "Mon quiz", total_questions: 3 },
};
const participants = [
  { id: "p1", pseudo: "Alice", score: 300, status: "answered" },
  { id: "p2", pseudo: "Bob", score: 100, status: "waiting" },
];

describe("SessionService : contrôle de propriété", () => {
  let service: SessionService;
  let supabase: SupabaseMock;

  beforeEach(async () => {
    supabase = createSupabaseMock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: SUPABASE_CLIENT, useValue: supabase.client },
      ],
    }).compile();

    service = moduleRef.get(SessionService);
  });

  describe("getSessionByCreator", () => {
    it("renvoie la session à son créateur", async () => {
      supabase.mockResponse("sessions", { data: session });
      await expect(service.getSessionByCreator("s1", OWNER)).resolves.toEqual(
        session,
      );
    });

    it("renvoie 404 à un autre utilisateur", async () => {
      supabase.mockResponse("sessions", { data: session });
      await expect(
        service.getSessionByCreator("s1", OTHER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("getSessionParticipantsForCreator", () => {
    it("renvoie les participants au créateur", async () => {
      supabase
        .mockResponse("sessions", { data: { creator_id: OWNER } })
        .mockResponse("participants", { data: participants });

      await expect(
        service.getSessionParticipantsForCreator("s1", OWNER),
      ).resolves.toEqual(participants);
    });

    it("renvoie 404 à un autre utilisateur, sans lire les participants", async () => {
      supabase.mockResponse("sessions", { data: { creator_id: OWNER } });

      await expect(
        service.getSessionParticipantsForCreator("s1", OTHER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(supabase.queriesFor("participants")).toHaveLength(0);
    });
  });

  describe("getSessionLeaderboardForCreator", () => {
    it("renvoie le classement au créateur", async () => {
      supabase
        .mockResponse("sessions", { data: { creator_id: OWNER } })
        .mockResponse("participants", { data: participants });

      const board = await service.getSessionLeaderboardForCreator("s1", OWNER);
      expect(board.map((e) => e.participant_id)).toEqual(["p1", "p2"]);
    });

    it("renvoie 404 à un autre utilisateur, sans lire les participants", async () => {
      supabase.mockResponse("sessions", { data: { creator_id: OWNER } });

      await expect(
        service.getSessionLeaderboardForCreator("s1", OTHER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(supabase.queriesFor("participants")).toHaveLength(0);
    });
  });

  describe("getSessionResults", () => {
    it("renvoie les résultats au créateur", async () => {
      supabase
        .mockResponse("sessions", { data: session })
        .mockResponse("participants", { data: participants })
        .mockResponse("participant_answers", { data: [{}, {}, {}] });

      const results = await service.getSessionResults("s1", OWNER);
      expect(results.session).toEqual(session);
      expect(results.total_answers).toBe(3);
      expect(results.leaderboard).toHaveLength(2);
    });

    it("renvoie 404 à un autre utilisateur, sans lire participants ni réponses", async () => {
      supabase.mockResponse("sessions", { data: session });

      await expect(
        service.getSessionResults("s1", OTHER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(supabase.queriesFor("participants")).toHaveLength(0);
      expect(supabase.queriesFor("participant_answers")).toHaveLength(0);
    });
  });

  describe("endSession", () => {
    it("renvoie 404 à un autre utilisateur, sans modifier la session", async () => {
      supabase.mockResponse("sessions", { data: { creator_id: OWNER } });

      await expect(service.endSession("s1", OTHER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(supabase.queriesFor("sessions")).toHaveLength(1);
    });

    it("autorise le créateur", async () => {
      supabase
        .mockResponse("sessions", { data: { creator_id: OWNER } })
        .mockResponse("sessions", { data: { id: "s1", status: "finished" } });

      await expect(service.endSession("s1", OWNER)).resolves.toEqual({
        id: "s1",
        status: "finished",
      });
    });
  });

  describe("createSession", () => {
    it("renvoie 404 si le quiz appartient à un autre utilisateur", async () => {
      supabase.mockResponse("quizzes", {
        data: { id: "quiz1", creator_id: OWNER, total_questions: 3 },
      });

      await expect(
        service.createSession(OTHER, { quiz_id: "quiz1" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(supabase.queriesFor("sessions")).toHaveLength(0);
    });
  });

  describe("createSession : unicité du code", () => {
    const quiz = {
      id: "quiz1",
      creator_id: OWNER,
      total_questions: 3,
      title: "Mon quiz",
    };
    const codeOf = (q: { calls: { method: string; args: unknown[] }[] }) =>
      q.calls.find((c) => c.method === "eq" && c.args[0] === "password")
        ?.args[1];

    it("retire un nouveau code tant qu'il est déjà utilisé", async () => {
      supabase
        .mockResponse("quizzes", { data: quiz })
        .mockResponse("sessions", { data: { id: "existing1" } })
        .mockResponse("sessions", { data: { id: "existing2" } })
        .mockResponse("sessions", { data: null })
        .mockResponse("sessions", { data: { id: "s-new" } });

      const created = await service.createSession(OWNER, { quiz_id: "quiz1" });

      const sessionQueries = supabase.queriesFor("sessions");
      // 3 vérifications d'unicité + 1 insertion
      expect(sessionQueries).toHaveLength(4);
      const insert = sessionQueries[3].calls.find((c) => c.method === "insert");
      const inserted = insert?.args[0] as { password: string };
      expect(inserted.password).toBe(codeOf(sessionQueries[2]));
      expect(inserted.password).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
      expect(created.id).toBe("s-new");
    });

    it("vérifie l'unicité parmi toutes les sessions joignables", async () => {
      supabase
        .mockResponse("quizzes", { data: quiz })
        .mockResponse("sessions", { data: null })
        .mockResponse("sessions", { data: { id: "s-new" } });

      await service.createSession(OWNER, { quiz_id: "quiz1" });

      const check = supabase.queriesFor("sessions")[0];
      expect(check.calls).toContainEqual({
        method: "in",
        args: ["status", ["waiting", "active", "paused"]],
      });
    });

    it("lève une erreur explicite après le nombre maximal de tentatives, sans insérer", async () => {
      supabase.mockResponse("quizzes", { data: quiz });
      for (let i = 0; i < MAX_SESSION_CODE_ATTEMPTS; i++) {
        supabase.mockResponse("sessions", { data: { id: `existing${i}` } });
      }

      await expect(
        service.createSession(OWNER, { quiz_id: "quiz1" }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      const sessionQueries = supabase.queriesFor("sessions");
      expect(sessionQueries).toHaveLength(MAX_SESSION_CODE_ATTEMPTS);
      expect(
        sessionQueries.some((q) => q.calls.some((c) => c.method === "insert")),
      ).toBe(false);
    });
  });

  describe("joinSession : normalisation du code", () => {
    it.each([
      ["abc234", "ABC234"],
      ["  abc234  ", "ABC234"],
      ["ab c2 34", "ABC234"],
      ["lmn234", "LMN234"], // ancien code contenant L : toujours accepté
    ])("recherche %p sous la forme %p", async (input, expected) => {
      supabase.mockResponse("sessions", { data: null });

      await expect(
        service.joinSession({ password: input, pseudo: "Alice" }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(supabase.queriesFor("sessions")[0].calls).toContainEqual({
        method: "eq",
        args: ["password", expected],
      });
    });
  });

  describe("accès internes (gateway)", () => {
    it("getSessionParticipants et getSessionLeaderboard restent sans contrôle", async () => {
      supabase
        .mockResponse("participants", { data: participants })
        .mockResponse("participants", { data: participants });

      await expect(service.getSessionParticipants("s1")).resolves.toEqual(
        participants,
      );
      await expect(service.getSessionLeaderboard("s1")).resolves.toHaveLength(
        2,
      );
      expect(supabase.queriesFor("sessions")).toHaveLength(0);
    });
  });
});
