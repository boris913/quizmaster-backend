import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { SessionService } from "./session.service";

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

  describe("deleteSession", () => {
    it("renvoie 404 à un autre utilisateur, sans rien supprimer", async () => {
      supabase.mockResponse("sessions", { data: { creator_id: OWNER } });

      await expect(service.deleteSession("s1", OTHER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const queries = supabase.queriesFor("sessions");
      expect(queries).toHaveLength(1);
      expect(queries[0].calls.some((c) => c.method === "delete")).toBe(false);
    });

    it("renvoie 404 si la session n'existe pas", async () => {
      supabase.mockResponse("sessions", { data: null });

      await expect(service.deleteSession("s1", OWNER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("supprime la session du créateur (la cascade SQL fait le reste)", async () => {
      supabase
        .mockResponse("sessions", { data: { creator_id: OWNER } })
        .mockResponse("sessions", { data: null });

      await expect(service.deleteSession("s1", OWNER)).resolves.toEqual({
        id: "s1",
        deleted: true,
      });

      const deletion = supabase.queriesFor("sessions")[1];
      expect(deletion.calls).toEqual([
        { method: "delete", args: [] },
        { method: "eq", args: ["id", "s1"] },
        { method: "eq", args: ["creator_id", OWNER] },
      ]);
      // Pas de suppression manuelle : on s'appuie sur ON DELETE CASCADE
      expect(supabase.queriesFor("participants")).toHaveLength(0);
      expect(supabase.queriesFor("participant_answers")).toHaveLength(0);
    });

    it("remonte une erreur Supabase", async () => {
      supabase
        .mockResponse("sessions", { data: { creator_id: OWNER } })
        .mockResponse("sessions", { error: { message: "boom" } });

      await expect(service.deleteSession("s1", OWNER)).rejects.toThrow("boom");
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
