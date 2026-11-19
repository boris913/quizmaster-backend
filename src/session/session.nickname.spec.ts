import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { NICKNAME_ERRORS } from "../common/utils/nickname.util";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { SessionService } from "./session.service";

const joinable = {
  id: "s1",
  status: "waiting",
  quiz_id: "quiz1",
  quizzes: { title: "Mon quiz", total_questions: 3 },
};

describe("SessionService : modération des pseudos (issue #5)", () => {
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

  /** Prépare la recherche de session par code puis son mode de pseudo. */
  const mockJoinableSession = (nicknameMode: string | null) => {
    supabase
      .mockResponse("sessions", { data: joinable })
      .mockResponse("sessions", { data: { nickname_mode: nicknameMode } });
  };

  const participantInserts = () =>
    supabase
      .queriesFor("participants")
      .filter((q) => q.calls.some((c) => c.method === "insert"));

  describe("joinSession (POST /api/sessions/join)", () => {
    it("refuse un pseudo interdit avec un message clair, sans créer de participant", async () => {
      mockJoinableSession("free");

      const promise = service.joinSession({ password: "ABC123", pseudo: "M3rd3" });
      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toThrow(NICKNAME_ERRORS.notAllowed);
      expect(participantInserts()).toHaveLength(0);
    });

    it("accepte un pseudo correct en mode free", async () => {
      mockJoinableSession("free");
      supabase
        .mockResponse("participants", { data: [] }) // pas d'exclusion
        .mockResponse("participants", { data: null }) // pseudo libre
        .mockResponse("participants", { data: { id: "p1", pseudo: "Connor" } });

      const result = await service.joinSession({
        password: "ABC123",
        pseudo: "Connor",
      });
      expect(result.participant).toEqual({ id: "p1", pseudo: "Connor" });
      expect(participantInserts()).toHaveLength(1);
    });

    it("mode generated : refuse un pseudo libre", async () => {
      mockJoinableSession("generated");

      await expect(
        service.joinSession({ password: "ABC123", pseudo: "Connor" }),
      ).rejects.toThrow(NICKNAME_ERRORS.mustBeGenerated);
      expect(participantInserts()).toHaveLength(0);
    });

    it("mode generated : accepte un pseudo issu du générateur", async () => {
      mockJoinableSession("generated");
      supabase
        .mockResponse("participants", { data: [] })
        .mockResponse("participants", { data: null })
        .mockResponse("participants", {
          data: { id: "p1", pseudo: "Loutre Curieuse" },
        });

      await expect(
        service.joinSession({ password: "ABC123", pseudo: "Loutre Curieuse" }),
      ).resolves.toEqual(
        expect.objectContaining({
          participant: { id: "p1", pseudo: "Loutre Curieuse" },
        }),
      );
    });

    it("refuse le pseudo d'un participant exclu de cette session", async () => {
      mockJoinableSession("free");
      supabase.mockResponse("participants", { data: [{ id: "p-kicked" }] });

      const promise = service.joinSession({ password: "ABC123", pseudo: "Toto_1" });
      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      await expect(promise).rejects.toThrow(NICKNAME_ERRORS.kicked);

      // Comparaison insensible à la casse, `_` échappé (ILIKE littéral)
      const kickedQuery = supabase.queriesFor("participants")[0];
      expect(kickedQuery.calls).toEqual(
        expect.arrayContaining([
          { method: "eq", args: ["status", "kicked"] },
          { method: "ilike", args: ["pseudo", "Toto\\_1"] },
        ]),
      );
      expect(participantInserts()).toHaveLength(0);
    });
  });

  describe("reconnectParticipant", () => {
    it("refuse un participant exclu", async () => {
      supabase.mockResponse("participants", {
        data: { id: "p1", session_id: "s1", pseudo: "Toto", status: "kicked" },
      });

      await expect(service.reconnectParticipant("s1", "p1")).rejects.toThrow(
        NICKNAME_ERRORS.kicked,
      );
      // Le statut n'est pas repassé à "waiting"
      expect(supabase.queriesFor("participants")).toHaveLength(1);
    });
  });

  describe("assertParticipantCanJoin (participant:join)", () => {
    it("refuse un participant exclu", async () => {
      supabase.mockResponse("participants", {
        data: { id: "p1", session_id: "s1", pseudo: "Toto", status: "kicked" },
      });
      await expect(
        service.assertParticipantCanJoin("s1", "p1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("refuse un participant d'une autre session", async () => {
      supabase.mockResponse("participants", {
        data: { id: "p1", session_id: "s2", pseudo: "Toto", status: "waiting" },
      });
      await expect(
        service.assertParticipantCanJoin("s1", "p1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("refuse un pseudo interdit", async () => {
      supabase
        .mockResponse("participants", {
          data: { id: "p1", session_id: "s1", pseudo: "c0n", status: "waiting" },
        })
        .mockResponse("sessions", { data: { id: "s1", nickname_mode: "free" } });
      await expect(service.assertParticipantCanJoin("s1", "p1")).rejects.toThrow(
        NICKNAME_ERRORS.notAllowed,
      );
    });

    it("accepte un participant valide", async () => {
      const participant = {
        id: "p1",
        session_id: "s1",
        pseudo: "Hibou Curieux",
        status: "disconnected",
      };
      supabase
        .mockResponse("participants", { data: participant })
        .mockResponse("sessions", {
          data: { id: "s1", nickname_mode: "generated" },
        });
      await expect(
        service.assertParticipantCanJoin("s1", "p1"),
      ).resolves.toEqual(participant);
    });
  });

  describe("kickParticipant", () => {
    it("passe le participant au statut kicked", async () => {
      supabase.mockResponse("participants", {
        data: { id: "p1", session_id: "s1", pseudo: "Toto", status: "waiting" },
      });

      await service.kickParticipant("s1", "p1");

      const update = supabase.queriesFor("participants")[1];
      expect(update.calls).toEqual([
        { method: "update", args: [{ status: "kicked", socket_id: null }] },
        { method: "eq", args: ["id", "p1"] },
      ]);
    });

    it("refuse un participant d'une autre session, sans le modifier", async () => {
      supabase.mockResponse("participants", {
        data: { id: "p1", session_id: "s2", pseudo: "Toto", status: "waiting" },
      });

      await expect(service.kickParticipant("s1", "p1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(supabase.queriesFor("participants")).toHaveLength(1);
    });
  });

  describe("getNicknameSuggestions (GET /api/sessions/join/nicknames)", () => {
    it("renvoie le mode et 3 propositions distinctes, hors pseudos pris", async () => {
      supabase
        .mockResponse("sessions", { data: { id: "s1", nickname_mode: "generated" } })
        .mockResponse("participants", { data: [{ pseudo: "Hibou Curieux" }] });

      const result = await service.getNicknameSuggestions(" abc123 ");

      expect(result.nickname_mode).toBe("generated");
      expect(result.suggestions).toHaveLength(3);
      expect(new Set(result.suggestions).size).toBe(3);
      expect(result.suggestions).not.toContain("Hibou Curieux");
      expect(supabase.queriesFor("sessions")[0].calls).toContainEqual({
        method: "eq",
        args: ["password", "ABC123"],
      });
    });

    it("renvoie 404 pour un code inconnu", async () => {
      await expect(
        service.getNicknameSuggestions("ZZZZZZ"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it("createSession enregistre le mode de pseudo (free par défaut)", async () => {
    const quiz = { id: "quiz1", creator_id: "u1", total_questions: 2, title: "Q" };
    supabase
      .mockResponse("quizzes", { data: quiz })
      .mockResponse("sessions", { data: null }) // code libre
      .mockResponse("sessions", { data: { id: "s1" } })
      .mockResponse("quizzes", { data: quiz })
      .mockResponse("sessions", { data: null })
      .mockResponse("sessions", { data: { id: "s2" } });

    await service.createSession("u1", { quiz_id: "quiz1" });
    await service.createSession("u1", {
      quiz_id: "quiz1",
      nicknameMode: "generated",
    });

    const inserts = supabase
      .queriesFor("sessions")
      .flatMap((q) => q.calls.filter((c) => c.method === "insert"))
      .map((c) => (c.args[0] as any).nickname_mode);
    expect(inserts).toEqual(["free", "generated"]);
  });
});
