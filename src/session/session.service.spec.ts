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
    it("renvoie les résultats enrichis au créateur", async () => {
      supabase
        .mockResponse("sessions", { data: session })
        .mockResponse("questions", {
          data: [
            {
              id: "q1",
              order_index: 0,
              text: "Capitale ?",
              type: "single",
              options: [{ id: "A" }, { id: "B" }],
              correct_answers: ["A"],
            },
          ],
        })
        .mockResponse("participants", { data: participants })
        .mockResponse("participant_answers", {
          data: [
            {
              participant_id: "p1",
              question_id: "q1",
              answers: ["A"],
              status: "answered",
              is_correct: true,
              time_taken_ms: 2000,
            },
            {
              participant_id: "p2",
              question_id: "q1",
              answers: [],
              status: "timeout",
              is_correct: false,
              time_taken_ms: null,
            },
          ],
        });

      const results = await service.getSessionResults("s1", OWNER);
      expect(results.session).toMatchObject({
        id: "s1",
        quizTitle: "Mon quiz",
        participantCount: 2,
      });
      expect(results.summary.accuracy).toBe(0.5);
      expect(results.perQuestion[0].answerDistribution).toEqual({ A: 1, B: 0 });
      expect(results.perParticipant.map((p) => p.participantId)).toEqual([
        "p1",
        "p2",
      ]);
      // Les questions sont lues pour le quiz de la session
      expect(supabase.queriesFor("questions")[0].calls).toContainEqual({
        method: "eq",
        args: ["quiz_id", "quiz1"],
      });
    });

    it("agrège plus de 1000 réponses lues sur plusieurs pages", async () => {
      // 35 élèves × 30 questions = 1050 lignes : au-delà de la limite PostgREST
      const questions = Array.from({ length: 30 }, (_, i) => ({
        id: `q${i}`,
        order_index: i,
        text: `Question ${i}`,
        type: "single",
        options: [{ id: "A" }, { id: "B" }],
        correct_answers: ["A"],
      }));
      const students = Array.from({ length: 35 }, (_, i) => ({
        id: `p${i}`,
        pseudo: `Élève ${i}`,
        score: 0,
      }));
      const rows = students.flatMap((p) =>
        questions.map((q) => ({
          participant_id: p.id,
          question_id: q.id,
          answers: ["A"],
          status: "answered",
          is_correct: true,
          time_taken_ms: 1000,
        })),
      );
      expect(rows).toHaveLength(1050);

      supabase
        .mockResponse("sessions", { data: session })
        .mockResponse("questions", { data: questions })
        .mockResponse("participants", { data: students })
        .mockResponse("participant_answers", { data: rows.slice(0, 1000) })
        .mockResponse("participant_answers", { data: rows.slice(1000) });

      const results = await service.getSessionResults("s1", OWNER);

      const pages = supabase.queriesFor("participant_answers");
      expect(pages).toHaveLength(2);
      expect(
        pages.map((q) => q.calls.find((c) => c.method === "range")),
      ).toEqual([
        { method: "range", args: [0, 999] },
        { method: "range", args: [1000, 1999] },
      ]);
      expect(pages[0].calls).toContainEqual({
        method: "order",
        args: ["id", { ascending: true }],
      });

      const answered = results.perParticipant.reduce(
        (sum, p) => sum + p.answered,
        0,
      );
      expect(answered).toBe(1050);
      // Les 50 dernières lignes (page 2) concernent les derniers élèves
      expect(
        results.perParticipant[results.perParticipant.length - 1],
      ).toMatchObject({
        participantId: "p34",
        answered: 30,
      });
      expect(results.summary.completionRate).toBe(1);
      expect(
        results.perQuestion.every((q) => q.answerDistribution.A === 35),
      ).toBe(true);
    });

    it("renvoie 404 à un autre utilisateur, sans lire participants ni réponses", async () => {
      supabase.mockResponse("sessions", { data: session });

      await expect(
        service.getSessionResults("s1", OTHER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(supabase.queriesFor("participants")).toHaveLength(0);
      expect(supabase.queriesFor("participant_answers")).toHaveLength(0);
      expect(supabase.queriesFor("questions")).toHaveLength(0);
    });

    it("renvoie 404 si la session n'existe pas", async () => {
      supabase.mockResponse("sessions", {
        data: null,
        error: { message: "x" },
      });
      await expect(
        service.getSessionResults("absente", OWNER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("propage une erreur de lecture Supabase", async () => {
      supabase
        .mockResponse("sessions", { data: session })
        .mockResponse("participant_answers", {
          error: { message: "boom" },
        });
      await expect(service.getSessionResults("s1", OWNER)).rejects.toThrow(
        "boom",
      );
    });
  });

  describe("getSessionResultsCsv", () => {
    it("renvoie le CSV (avec BOM) et un nom de fichier au créateur", async () => {
      supabase
        .mockResponse("sessions", { data: session })
        .mockResponse("participants", { data: participants });

      const { filename, csv } = await service.getSessionResultsCsv("s1", OWNER);
      expect(filename).toBe("resultats-mon-quiz.csv");
      expect(csv.startsWith("﻿Rang;Pseudo;")).toBe(true);
      expect(csv).toContain("1;Alice;300;");
    });

    it("renvoie 404 à un autre utilisateur, sans lire les réponses", async () => {
      supabase.mockResponse("sessions", { data: session });

      await expect(
        service.getSessionResultsCsv("s1", OTHER),
      ).rejects.toBeInstanceOf(NotFoundException);
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

  describe("createSession : unicité du code", () => {
    const quiz = {
      id: "quiz1",
      creator_id: OWNER,
      total_questions: 3,
      title: "Mon quiz",
    };
    const conflict = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "sessions_password_key"',
      details: "Key (password)=(ABC234) already exists.",
    };
    const insertedCode = (q: {
      calls: { method: string; args: unknown[] }[];
    }) =>
      (
        q.calls.find((c) => c.method === "insert")?.args[0] as {
          password: string;
        }
      ).password;

    it("retire un code s'il correspond à une session existante, même terminée", async () => {
      supabase
        .mockResponse("quizzes", { data: quiz })
        .mockResponse("sessions", { error: conflict })
        .mockResponse("sessions", { data: { id: "s-new", status: "waiting" } });

      const created = await service.createSession(OWNER, { quiz_id: "quiz1" });

      const inserts = supabase.queriesFor("sessions");
      expect(inserts).toHaveLength(2);
      for (const q of inserts) {
        expect(insertedCode(q)).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
      }
      expect(created.id).toBe("s-new");
      expect(created.quiz_title).toBe("Mon quiz");
    });

    it("lève une erreur 503 explicite après le nombre maximal de tentatives", async () => {
      supabase.mockResponse("quizzes", { data: quiz });
      for (let i = 0; i < MAX_SESSION_CODE_ATTEMPTS; i++) {
        supabase.mockResponse("sessions", { error: conflict });
      }

      await expect(
        service.createSession(OWNER, { quiz_id: "quiz1" }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(supabase.queriesFor("sessions")).toHaveLength(
        MAX_SESSION_CODE_ATTEMPTS,
      );
    });

    it("ne réessaie pas une autre erreur d'insertion", async () => {
      supabase
        .mockResponse("quizzes", { data: quiz })
        .mockResponse("sessions", {
          error: { code: "23503", message: "foreign key violation" },
        });

      await expect(
        service.createSession(OWNER, { quiz_id: "quiz1" }),
      ).rejects.toThrow("Erreur création session: foreign key violation");
      expect(supabase.queriesFor("sessions")).toHaveLength(1);
    });

    it("ne réessaie pas une violation d'unicité portant sur une autre contrainte", async () => {
      supabase
        .mockResponse("quizzes", { data: quiz })
        .mockResponse("sessions", {
          error: {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "sessions_pkey"',
            details: "Key (id)=(s1) already exists.",
          },
        });

      await expect(
        service.createSession(OWNER, { quiz_id: "quiz1" }),
      ).rejects.toThrow(/Erreur création session/);
      expect(supabase.queriesFor("sessions")).toHaveLength(1);
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
