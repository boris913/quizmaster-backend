import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { QuizService } from "./quiz.service";

const OWNER = "user-owner";
const OTHER = "user-other";

const quiz = { id: "quiz1", title: "Mon quiz", creator_id: OWNER };
const questions = [
  {
    id: "q1",
    quiz_id: "quiz1",
    text: "2 + 2 ?",
    correct_answers: ["B"],
    order_index: 0,
  },
];

describe("QuizService : contrôle de propriété", () => {
  let service: QuizService;
  let supabase: SupabaseMock;

  beforeEach(async () => {
    supabase = createSupabaseMock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        QuizService,
        { provide: SUPABASE_CLIENT, useValue: supabase.client },
      ],
    }).compile();

    service = moduleRef.get(QuizService);
  });

  describe("getQuizById", () => {
    it("renvoie le quiz et ses questions à son créateur", async () => {
      supabase
        .mockResponse("quizzes", { data: quiz })
        .mockResponse("questions", { data: questions });

      await expect(service.getQuizById("quiz1", OWNER)).resolves.toEqual({
        ...quiz,
        questions,
      });
    });

    it("renvoie 404 à un autre utilisateur, sans charger les questions", async () => {
      supabase
        .mockResponse("quizzes", { data: quiz })
        .mockResponse("questions", { data: questions });

      await expect(service.getQuizById("quiz1", OTHER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // Les bonnes réponses ne sont jamais lues pour un non-propriétaire
      expect(supabase.queriesFor("questions")).toHaveLength(0);
    });

    it("renvoie la même erreur 404 que pour un quiz inexistant", async () => {
      supabase.mockResponse("quizzes", {
        data: null,
        error: { message: "not found" },
      });
      const missing = await service
        .getQuizById("absent", OWNER)
        .catch((e: Error) => e);

      supabase.mockResponse("quizzes", { data: quiz });
      const forbidden = await service
        .getQuizById("quiz1", OTHER)
        .catch((e: Error) => e);

      expect(forbidden).toBeInstanceOf(NotFoundException);
      expect(missing).toBeInstanceOf(NotFoundException);
      expect((forbidden as Error).message).toBe((missing as Error).message);
    });

    it("renvoie 404 sans identifiant de demandeur", async () => {
      supabase.mockResponse("quizzes", { data: quiz });

      await expect(
        service.getQuizById("quiz1", undefined as unknown as string),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("méthodes de modification (assertOwnership)", () => {
    const cases: Array<[string, (s: QuizService, user: string) => unknown]> = [
      ["updateQuiz", (s, u) => s.updateQuiz("quiz1", u, { title: "X" })],
      ["deleteQuiz", (s, u) => s.deleteQuiz("quiz1", u)],
      [
        "addQuestions",
        (s, u) =>
          s.addQuestions("quiz1", u, [
            {
              text: "Q",
              type: "single",
              options: [
                { id: "A", text: "a" },
                { id: "B", text: "b" },
              ],
              correct_answers: ["A"],
              max_points: 100,
            },
          ]),
      ],
      ["deleteQuestion", (s, u) => s.deleteQuestion("quiz1", "q1", u)],
      ["reorderQuestions", (s, u) => s.reorderQuestions("quiz1", u, ["q1"])],
      [
        "importFromMarkdown",
        (s, u) =>
          s.importFromMarkdown("quiz1", u, {
            questions_content: "Question 1\nTexte\nA) a [correct]\nB) b",
          }),
      ],
    ];

    it.each(cases)(
      "%s : renvoie 404 à un autre utilisateur, sans écrire",
      async (_name, call) => {
        supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });

        await expect(call(service, OTHER)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        // Une seule requête : la lecture du propriétaire
        expect(supabase.queriesFor("quizzes")).toHaveLength(1);
        expect(supabase.queriesFor("questions")).toHaveLength(0);
      },
    );

    it("deleteQuiz : autorise le créateur", async () => {
      supabase
        .mockResponse("quizzes", { data: { creator_id: OWNER } })
        .mockResponse("quizzes", { data: null, error: null });

      await expect(service.deleteQuiz("quiz1", OWNER)).resolves.toEqual({
        message: "Quiz supprimé avec succès",
      });
      const [, deleteQuery] = supabase.queriesFor("quizzes");
      expect(deleteQuery.calls.map((c) => c.method)).toEqual(["delete", "eq"]);
    });
  });
});
