import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { buildKahootFixture, buildXlsx } from "../test-utils/xlsx-fixtures";
import { ImportQueryDto } from "./dto/quiz.dto";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
} from "./importers/import.types";
import { TEMPLATE_HEADERS } from "./importers/tabular.importer";
import { QuizService, UploadedImportFile } from "./quiz.service";

const OWNER = "user-owner";
const OTHER = "user-other";
const QUIZ = "quiz-1";

const file = (
  content: string | Buffer,
  originalname = "questions.csv",
): UploadedImportFile => {
  const buffer = Buffer.isBuffer(content)
    ? content
    : Buffer.from(content, "utf8");
  return { buffer, size: buffer.length, originalname };
};

describe("QuizService : import CSV / XLSX / Kahoot (issue #12)", () => {
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

  const inserts = () =>
    supabase
      .queriesFor("questions")
      .flatMap((q) => q.calls)
      .filter((c) => c.method === "insert");
  const insertedRows = (): any[] => (inserts()[0]?.args[0] as any[]) ?? [];

  /** Propriété OK + insertion (index existant puis insert renvoyant n lignes). */
  const mockImport = (inserted = 1) =>
    supabase
      .mockResponse("quizzes", { data: { creator_id: OWNER } })
      .mockResponse("questions", { data: [] })
      .mockResponse("questions", {
        data: Array.from({ length: inserted }, (_, i) => ({ id: `q${i}` })),
      });

  const run = (format: string, f?: UploadedImportFile, dryRun = false) =>
    service.importQuestions(
      QUIZ,
      OWNER,
      { format: format as any, dryRun },
      {},
      f,
    );

  describe("CSV", () => {
    const csv = [
      "type;question;option_a;option_b;option_c;bonnes_reponses;points;timer;explication",
      'single;"Capitale ; France ?";Lyon;Paris;;B;100;30;"Ligne 1\nLigne 2"',
      "multiple;Premiers ?;2;4;7;A,C;;;",
      "essay;Inconnu;;;;;;;",
      "single;Sans bonne réponse;x;y;;;;;",
      "true_false;La Terre est plate.;;;;faux;50;10;",
    ].join("\r\n");

    it("importe les lignes valides et liste les erreurs par ligne", async () => {
      mockImport(3);
      const result = await run("csv", file("\uFEFF" + csv));

      expect(result).toMatchObject({
        format: "csv",
        dry_run: false,
        total_rows: 5,
        valid: 3,
        imported: 3,
      });
      expect((result as any).errors).toEqual([
        { row: 4, message: expect.stringContaining('type inconnu "essay"') },
        { row: 5, message: expect.stringContaining("exactement 1 bonne") },
      ]);
      const rows = insertedRows();
      expect(rows.map((r) => r.text)).toEqual([
        "Capitale ; France ?",
        "Premiers ?",
        "La Terre est plate.",
      ]);
      expect(rows[0]).toMatchObject({
        type: "single",
        correct_answers: ["B"],
        explanation: "Ligne 1\nLigne 2",
        order_index: 0,
      });
      expect(rows[1]).toMatchObject({ max_points: 100, timer_seconds: 30 });
      expect(rows[2]).toMatchObject({
        type: "true_false",
        correct_answers: ["false"],
        options: [
          { id: "true", text: "Vrai" },
          { id: "false", text: "Faux" },
        ],
      });
    });

    it("accepte le séparateur virgule", async () => {
      mockImport(1);
      const result = await run(
        "csv",
        file('question,option_a,option_b,bonnes_reponses\n"Q, ok ?",x,y,A\n'),
      );
      expect(result).toMatchObject({ imported: 1, errors: [] });
      expect(insertedRows()[0].text).toBe("Q, ok ?");
    });

    it("dryRun : analyse et validation, aucune écriture", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const result = await run("csv", file(csv), true);

      expect(result).toMatchObject({ dry_run: true, valid: 3, imported: 0 });
      expect((result as any).questions[0]).toMatchObject({
        row: 2,
        text: "Capitale ; France ?",
        type: "single",
      });
      expect((result as any).errors).toHaveLength(2);
      expect(inserts()).toHaveLength(0);
    });

    it("applique la validation du DTO (champs, bornes, URL d'image)", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const result: any = await run(
        "csv",
        file(
          [
            "question;option_a;option_b;bonnes_reponses;points;timer;image_url",
            "Q1;x;y;A;5;30;",
            "Q2;x;y;A;100;3;",
            "Q3;x;y;A;100;30;javascript:alert(1)",
            ";x;y;A;100;30;",
            `${"Q".repeat(1001)};x;y;A;100;30;`,
          ].join("\n"),
        ),
        true,
      );
      expect(result.valid).toBe(0);
      expect(result.errors.map((e: any) => e.row)).toEqual([2, 3, 4, 5, 6]);
      expect(result.errors[0].message).toMatch(/max_points/);
      expect(result.errors[1].message).toMatch(/timer_seconds/);
      expect(result.errors[2].message).toMatch(/image_url/);
      expect(result.errors[3].message).toMatch(/énoncé/);
    });

    it("aucune ligne valide : rien n'est inséré", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const result = await run("csv", file("question;type\nQ;essay"));
      expect(result).toMatchObject({ imported: 0, valid: 0 });
      expect(inserts()).toHaveLength(0);
    });

    it("refuse plus de 200 lignes de données (400)", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const lines = ["question;option_a;option_b;bonnes_reponses"];
      for (let i = 0; i <= IMPORT_MAX_ROWS; i++) lines.push(`Q${i};x;y;A`);
      await expect(run("csv", file(lines.join("\n")))).rejects.toThrow(
        BadRequestException,
      );
      expect(inserts()).toHaveLength(0);
    });

    it("200 lignes de données exactement : accepté", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const lines = ["question;option_a;option_b;bonnes_reponses"];
      for (let i = 0; i < IMPORT_MAX_ROWS; i++) lines.push(`Q${i};x;y;A`);
      const result = await run("csv", file(lines.join("\n")), true);
      expect(result).toMatchObject({ valid: IMPORT_MAX_ROWS });
    });

    it("refuse un fichier trop gros (413)", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const big = Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1, 0x61);
      await expect(run("csv", file(big))).rejects.toThrow(
        PayloadTooLargeException,
      );
    });

    it("refuse un XLSX annoncé comme CSV (415)", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const xlsx = await buildXlsx([["question"], ["Q"]]);
      await expect(run("csv", file(xlsx, "questions"))).rejects.toThrow(
        UnsupportedMediaTypeException,
      );
    });

    it("refuse une extension incompatible avec le format (415)", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      await expect(
        run("csv", file("question\nQ", "questions.exe")),
      ).rejects.toThrow(UnsupportedMediaTypeException);
    });

    it("fichier manquant (400)", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      await expect(run("csv")).rejects.toThrow(BadRequestException);
    });

    it("quiz d'un autre utilisateur : 404 avant toute lecture du fichier", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      await expect(
        service.importQuestions(
          QUIZ,
          OTHER,
          { format: "csv" },
          {},
          file("question\nQ"),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it("le modèle téléchargeable est réimportable sans erreur", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const template = service.getImportTemplateCsv();
      expect(template.startsWith("\uFEFF" + TEMPLATE_HEADERS.join(";"))).toBe(
        true,
      );
      const result = await run("csv", file(template), true);
      expect(result).toMatchObject({ valid: 6, errors: [] });
    });
  });

  describe("XLSX", () => {
    it("importe la première feuille avec les colonnes du modèle", async () => {
      mockImport(2);
      const xlsx = await buildXlsx([
        ["type", "question", "option_a", "option_b", "bonnes_reponses", "points"],
        ["single", "Q1", "x", "y", "A", 100],
        ["short_answer", "Q2", "", "", "Paris|Paname", { formula: "50*2", result: 100 }],
        ["poll", "Q3", "seul", "", "", 100],
      ]);
      const result: any = await run("xlsx", file(xlsx, "quiz.xlsx"));
      expect(result).toMatchObject({ valid: 2, imported: 2 });
      expect(result.errors).toEqual([
        { row: 4, message: expect.stringContaining("entre 2 et 6 options") },
      ]);
      expect(insertedRows()[1]).toMatchObject({
        type: "short_answer",
        correct_answers: ["Paris", "Paname"],
        max_points: 100,
      });
    });

    it("refuse un CSV annoncé comme XLSX (415)", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      await expect(
        run("xlsx", file("question;type\nQ;single", "quiz.xlsx")),
      ).rejects.toThrow(UnsupportedMediaTypeException);
    });

    it("refuse plus de 200 lignes (400)", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const rows: unknown[][] = [["question", "option_a", "option_b", "bonnes_reponses"]];
      for (let i = 0; i <= IMPORT_MAX_ROWS; i++) rows.push([`Q${i}`, "x", "y", "A"]);
      await expect(run("xlsx", file(await buildXlsx(rows), "q.xlsx"))).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("Kahoot", () => {
    it("importe la fixture Kahoot (dryRun puis import)", async () => {
      const fixture = await buildKahootFixture();
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const preview: any = await run("kahoot", file(fixture, "kahoot.xlsx"), true);
      expect(preview).toMatchObject({ valid: 3, imported: 0, total_rows: 4 });
      expect(preview.errors).toEqual([
        { row: 12, message: expect.any(String) },
      ]);
      expect(inserts()).toHaveLength(0);

      mockImport(3);
      const result: any = await run("kahoot", file(fixture, "kahoot.xlsx"));
      expect(result.imported).toBe(3);
      expect(insertedRows().map((r) => r.type)).toEqual([
        "single",
        "multiple",
        "single",
      ]);
    });

    it("refuse un classeur qui n'a pas le format Kahoot (400)", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const xlsx = await buildXlsx([["question"], ["Q"]]);
      await expect(run("kahoot", file(xlsx, "k.xlsx"))).rejects.toThrow(
        /Format Kahoot non reconnu/,
      );
    });
  });

  describe("Markdown", () => {
    const md = [
      "Question 1",
      "Capitale ?",
      "A) Lyon",
      "B) Paris [correct]",
      "",
      "Question 2 [type: short_answer]",
      "Or ?",
      "= Au",
    ].join("\n");

    it("format=markdown : nouveau contrat, depuis un fichier ou le corps JSON", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const fromFile: any = await run("markdown", file(md, "quiz.md"), true);
      expect(fromFile).toMatchObject({ valid: 2, imported: 0, errors: [] });

      mockImport(2);
      const fromBody: any = await service.importQuestions(
        QUIZ,
        OWNER,
        { format: "markdown" },
        { questions_content: md },
      );
      expect(fromBody).toMatchObject({ imported: 2 });
    });

    it("sans format : comportement historique inchangé (questions créées)", async () => {
      // importFromMarkdown → assertOwnership, puis addQuestions → assertOwnership
      supabase
        .mockResponse("quizzes", { data: { creator_id: OWNER } })
        .mockResponse("quizzes", { data: { creator_id: OWNER } })
        .mockResponse("questions", { data: [] })
        .mockResponse("questions", { data: [{ id: "a" }, { id: "b" }] });
      const result = await service.importQuestions(
        QUIZ,
        OWNER,
        {},
        { questions_content: md },
      );
      expect(result).toEqual([{ id: "a" }, { id: "b" }]);
    });

    it("sans format, un fichier est refusé (400)", async () => {
      await expect(
        service.importQuestions(QUIZ, OWNER, {}, {}, file(md, "quiz.md")),
      ).rejects.toThrow(/format requis/);
    });
  });
});

describe("ImportQueryDto", () => {
  const check = async (plain: unknown) => {
    const dto = plainToInstance(ImportQueryDto, plain);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return { dto, errors };
  };

  it("accepte format et dryRun (chaîne de requête)", async () => {
    const { dto, errors } = await check({ format: "kahoot", dryRun: "true" });
    expect(errors).toHaveLength(0);
    expect(dto.dryRun).toBe(true);
    expect((await check({ dryRun: "0" })).dto.dryRun).toBe(false);
  });

  it("refuse un format inconnu, un dryRun invalide et les paramètres inconnus", async () => {
    expect((await check({ format: "pdf" })).errors).toHaveLength(1);
    expect((await check({ dryRun: "peut-être" })).errors).toHaveLength(1);
    expect((await check({ foo: "1" })).errors).toHaveLength(1);
  });
});
