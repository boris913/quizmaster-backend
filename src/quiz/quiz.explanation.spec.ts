import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { CreateQuestionDto } from "./dto/quiz.dto";
import { QuizService } from "./quiz.service";

const OWNER = "user-owner";

describe("QuizService : explication des réponses (issue #6)", () => {
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

  /** Lignes envoyées à `questions.insert(...)`. */
  const insertedRows = (): any[] => {
    const insert = supabase
      .queriesFor("questions")
      .flatMap((q) => q.calls)
      .find((c) => c.method === "insert");
    return insert ? (insert.args[0] as any[]) : [];
  };

  const mockOwnerAndQuestions = () => {
    supabase
      .mockResponse("quizzes", { data: { creator_id: OWNER } }) // import
      .mockResponse("quizzes", { data: { creator_id: OWNER } }) // addQuestions
      .mockResponse("questions", { data: [] }) // index courant
      .mockResponse("questions", { data: [] }); // insert
  };

  it("importe la ligne « > Explication : ... » sous la question", async () => {
    mockOwnerAndQuestions();

    await service.importFromMarkdown("quiz1", OWNER, {
      questions_content: [
        "Quiz: Géographie",
        "",
        "Question 1 [timer:20] [points:100]",
        "Capitale de la France ?",
        "A) Lyon",
        "B) Paris [correct]",
        "> Explication : Paris est la capitale depuis 987.",
        "",
        "Question 2",
        "Nombres pairs ?",
        "> explication: 2 et 4 sont divisibles par 2.",
        "A) 2 [correct]",
        "B) 3",
        "C) 4 [correct]",
        "",
        "Question 3",
        "Sans explication ?",
        "A) Oui [correct]",
        "B) Non",
      ].join("\n"),
    });

    const rows = insertedRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      text: "Capitale de la France ?",
      correct_answers: ["B"],
      explanation: "Paris est la capitale depuis 987.",
    });
    expect(rows[1]).toMatchObject({
      text: "Nombres pairs ?",
      type: "multiple",
      correct_answers: ["A", "C"],
      explanation: "2 et 4 sont divisibles par 2.",
    });
    // La ligne d'explication n'est pas prise pour une option
    expect(rows[1].options).toHaveLength(3);
    expect(rows[2].explanation).toBeNull();
  });

  it("gère les fins de ligne Windows (CRLF)", async () => {
    mockOwnerAndQuestions();

    await service.importFromMarkdown("quiz1", OWNER, {
      questions_content:
        "Question 1\r\nTexte\r\nA) a [correct]\r\nB) b\r\n> Explication : parce que.\r\n",
    });

    expect(insertedRows()[0].explanation).toBe("parce que.");
  });

  it("refuse une explication de plus de 500 caractères à l'import", async () => {
    supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });

    await expect(
      service.importFromMarkdown("quiz1", OWNER, {
        questions_content: `Question 1\nTexte\nA) a [correct]\nB) b\n> Explication : ${"x".repeat(501)}`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(supabase.queriesFor("questions")).toHaveLength(0);
  });

  it("addQuestions enregistre l'explication (vide → null)", async () => {
    supabase
      .mockResponse("quizzes", { data: { creator_id: OWNER } })
      .mockResponse("questions", { data: [] })
      .mockResponse("questions", { data: [] });

    const base = {
      type: "single" as const,
      options: [
        { id: "A", text: "a" },
        { id: "B", text: "b" },
      ],
      correct_answers: ["A"],
      max_points: 100,
    };
    await service.addQuestions("quiz1", OWNER, [
      { ...base, text: "Q1", explanation: "  Parce que A.  " },
      { ...base, text: "Q2", explanation: "   " },
      { ...base, text: "Q3" },
    ]);

    expect(insertedRows().map((r) => r.explanation)).toEqual([
      "Parce que A.",
      null,
      null,
    ]);
  });

  describe("CreateQuestionDto.explanation", () => {
    const dto = (explanation: unknown) =>
      plainToInstance(CreateQuestionDto, {
        text: "Q",
        type: "single",
        options: [
          { id: "A", text: "a" },
          { id: "B", text: "b" },
        ],
        correct_answers: ["A"],
        max_points: 100,
        explanation,
      });

    it("est facultative", async () => {
      expect(await validate(dto(undefined))).toHaveLength(0);
    });

    it("accepte 500 caractères et refuse au-delà", async () => {
      expect(await validate(dto("x".repeat(500)))).toHaveLength(0);
      const errors = await validate(dto("x".repeat(501)));
      expect(errors.map((e) => e.property)).toEqual(["explanation"]);
    });
  });
});
