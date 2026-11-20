import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import {
  AddQuestionsDto,
  CreateQuestionDto,
  ImageUploadUrlDto,
} from "./dto/quiz.dto";
import { QUESTION_IMAGES_BUCKET, QuizService } from "./quiz.service";

const OWNER = "user-owner";
const OTHER = "user-other";

const base = { text: "Énoncé ?", max_points: 100, timer_seconds: 20 };
const opts = (...ids: string[]) => ids.map((id) => ({ id, text: `T${id}` }));

async function errorsOf(cls: any, plain: unknown): Promise<string> {
  const errors = await validate(plainToInstance(cls, plain) as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const collect = (list: any[]): string[] =>
    list.flatMap((e) => [
      ...Object.values(e.constraints ?? {}).map(String),
      ...collect(e.children ?? []),
    ]);
  return collect(errors).join(" | ");
}

describe("CreateQuestionDto : validation par type (issue #7)", () => {
  const ok = async (q: any) =>
    expect(await errorsOf(CreateQuestionDto, { ...base, ...q })).toBe("");
  const ko = async (q: any, fragment: string) =>
    expect(await errorsOf(CreateQuestionDto, { ...base, ...q })).toContain(
      fragment,
    );

  it("accepte chaque type bien formé", async () => {
    await ok({
      type: "single",
      options: opts("A", "B"),
      correct_answers: ["A"],
    });
    await ok({
      type: "multiple",
      options: opts("A", "B", "C"),
      correct_answers: ["A", "B"],
    });
    await ok({ type: "true_false", correct_answers: ["false"] });
    await ok({
      type: "true_false",
      options: [
        { id: "true", text: "Vrai" },
        { id: "false", text: "Faux" },
      ],
      correct_answers: ["true"],
    });
    await ok({
      type: "ordering",
      options: opts("A", "B", "C", "D", "E"),
      correct_answers: ["E", "D", "C", "B", "A"],
    });
    await ok({ type: "short_answer", correct_answers: ["Paris", "paname"] });
    await ok({ type: "poll", options: opts("A", "B", "C", "D", "E", "F") });
  });

  it("refuse un type inconnu", async () => {
    await ko({ type: "essay", options: opts("A", "B") }, "type");
  });

  it("true_false : options libres ou bonne réponse invalide refusées", async () => {
    await ko(
      { type: "true_false", options: opts("A", "B"), correct_answers: ["A"] },
      "2 options fixes",
    );
    await ko({ type: "true_false", correct_answers: ["vrai"] }, '["true"]');
  });

  it("ordering : moins de 3 options ou séquence incomplète refusées", async () => {
    await ko(
      {
        type: "ordering",
        options: opts("A", "B"),
        correct_answers: ["B", "A"],
      },
      "entre 3 et 6",
    );
    await ko(
      {
        type: "ordering",
        options: opts("A", "B", "C"),
        correct_answers: ["C", "A"],
      },
      "tous les ids",
    );
  });

  it("short_answer : options ou absence de variante refusées", async () => {
    await ko(
      { type: "short_answer", options: opts("A", "B"), correct_answers: ["x"] },
      "pas d'options",
    );
    await ko({ type: "short_answer" }, "entre 1 et 20");
    await ko(
      { type: "short_answer", correct_answers: ["x".repeat(101)] },
      "100",
    );
  });

  it("poll : bonne réponse refusée", async () => {
    await ko(
      { type: "poll", options: opts("A", "B"), correct_answers: ["A"] },
      "pas de bonne réponse",
    );
  });

  it("single / multiple : règles historiques conservées (ids A-D)", async () => {
    await ko(
      { type: "single", options: opts("A", "E"), correct_answers: ["A"] },
      "ids d'option invalides",
    );
    await ko({ type: "multiple", options: opts("A", "B") }, "au moins 1");
  });

  it("image_url : http(s) uniquement, 2048 caractères au plus, null accepté", async () => {
    const q = {
      type: "single",
      options: opts("A", "B"),
      correct_answers: ["A"],
    };
    await ok({ ...q, image_url: "https://x.supabase.co/storage/v1/a.png" });
    await ok({ ...q, image_url: null });
    await ko({ ...q, image_url: "javascript:alert(1)" }, "http(s)");
    await ko({ ...q, image_url: `https://x.co/${"a".repeat(2048)}` }, "2048");
  });

  it("AddQuestionsDto valide chaque question du corps", async () => {
    expect(
      await errorsOf(AddQuestionsDto, {
        questions: [
          {
            ...base,
            type: "poll",
            options: opts("A", "B"),
            correct_answers: ["A"],
          },
        ],
      }),
    ).toContain("pas de bonne réponse");
    expect(await errorsOf(AddQuestionsDto, { questions: [] })).not.toBe("");
  });
});

describe("ImageUploadUrlDto (issue #7)", () => {
  it.each(["image/png", "image/jpeg", "image/webp", "image/gif"])(
    "accepte %s",
    async (type) => {
      expect(
        await errorsOf(ImageUploadUrlDto, { content_type: type, size: 1000 }),
      ).toBe("");
    },
  );

  it("refuse un autre type MIME", async () => {
    for (const type of ["image/svg+xml", "application/pdf", "text/html", ""]) {
      expect(
        await errorsOf(ImageUploadUrlDto, { content_type: type, size: 1000 }),
      ).toContain("content_type");
    }
  });

  it("refuse une taille nulle, non entière ou supérieure à 2 Mo", async () => {
    expect(
      await errorsOf(ImageUploadUrlDto, {
        content_type: "image/png",
        size: 2 * 1024 * 1024,
      }),
    ).toBe("");
    for (const size of [0, -1, 1.5, 2 * 1024 * 1024 + 1]) {
      expect(
        await errorsOf(ImageUploadUrlDto, { content_type: "image/png", size }),
      ).not.toBe("");
    }
  });
});

describe("QuizService : types de question et images (issue #7)", () => {
  let service: QuizService;
  let supabase: SupabaseMock;
  let storageBucket: {
    createSignedUploadUrl: jest.Mock;
    getPublicUrl: jest.Mock;
  };
  let storageFrom: jest.Mock;

  beforeEach(async () => {
    supabase = createSupabaseMock();
    storageBucket = {
      createSignedUploadUrl: jest.fn(async (path: string) => ({
        data: {
          signedUrl: `https://proj.supabase.co/storage/v1/object/upload/sign/question-images/${path}?token=tok`,
          token: "tok",
          path,
        },
        error: null,
      })),
      getPublicUrl: jest.fn((path: string) => ({
        data: {
          publicUrl: `https://proj.supabase.co/storage/v1/object/public/question-images/${path}`,
        },
      })),
    };
    storageFrom = jest.fn(() => storageBucket);
    const client = Object.assign(Object.create(null), supabase.client, {
      storage: { from: storageFrom },
    });
    const moduleRef = await Test.createTestingModule({
      providers: [QuizService, { provide: SUPABASE_CLIENT, useValue: client }],
    }).compile();
    service = moduleRef.get(QuizService);
  });

  const insertedRows = (): any[] => {
    const insert = supabase
      .queriesFor("questions")
      .flatMap((q) => q.calls)
      .find((c) => c.method === "insert");
    return insert ? (insert.args[0] as any[]) : [];
  };

  const mockAdd = () =>
    supabase
      .mockResponse("quizzes", { data: { creator_id: OWNER } })
      .mockResponse("questions", { data: [] })
      .mockResponse("questions", { data: [] });

  describe("addQuestions : enregistrement par type", () => {
    it("true_false : options fixes, textes fournis conservés", async () => {
      mockAdd();
      await service.addQuestions("quiz1", OWNER, [
        { ...base, type: "true_false", correct_answers: ["false"] },
      ] as CreateQuestionDto[]);
      expect(insertedRows()[0]).toMatchObject({
        type: "true_false",
        options: [
          { id: "true", text: "Vrai" },
          { id: "false", text: "Faux" },
        ],
        correct_answers: ["false"],
        image_url: null,
      });

      supabase.reset();
      mockAdd();
      await service.addQuestions("quiz1", OWNER, [
        {
          ...base,
          type: "true_false",
          options: [
            { id: "false", text: "Non" },
            { id: "true", text: "Oui" },
          ],
          correct_answers: ["true"],
        },
      ] as CreateQuestionDto[]);
      expect(insertedRows()[0].options).toEqual([
        { id: "true", text: "Oui" },
        { id: "false", text: "Non" },
      ]);
    });

    it("short_answer : options vides, variantes rognées et dédoublonnées", async () => {
      mockAdd();
      await service.addQuestions("quiz1", OWNER, [
        {
          ...base,
          type: "short_answer",
          correct_answers: [" Paris ", "paris", "PARIS !", "Paname"],
        },
      ] as CreateQuestionDto[]);
      expect(insertedRows()[0]).toMatchObject({
        options: [],
        correct_answers: ["Paris", "Paname"],
      });
    });

    it("poll : aucune bonne réponse enregistrée", async () => {
      mockAdd();
      await service.addQuestions("quiz1", OWNER, [
        { ...base, type: "poll", options: opts("A", "B") },
      ] as CreateQuestionDto[]);
      expect(insertedRows()[0]).toMatchObject({
        options: opts("A", "B"),
        correct_answers: [],
      });
    });

    it("ordering : ids réattribués, même séquence de textes", async () => {
      mockAdd();
      const options = [
        { id: "A", text: "Un" },
        { id: "B", text: "Deux" },
        { id: "C", text: "Trois" },
      ];
      await service.addQuestions("quiz1", OWNER, [
        {
          ...base,
          type: "ordering",
          options,
          correct_answers: ["A", "B", "C"],
        },
      ] as CreateQuestionDto[]);
      const row = insertedRows()[0];
      const byId = new Map(row.options.map((o: any) => [o.id, o.text]));
      expect(row.correct_answers.map((id: string) => byId.get(id))).toEqual([
        "Un",
        "Deux",
        "Trois",
      ]);
      expect(row.options.map((o: any) => o.id)).toEqual(["A", "B", "C"]);
    });

    it("image_url enregistrée (vide → null)", async () => {
      mockAdd();
      await service.addQuestions("quiz1", OWNER, [
        {
          ...base,
          type: "single",
          options: opts("A", "B"),
          correct_answers: ["A"],
          image_url: " https://cdn.example/a.png ",
        },
        {
          ...base,
          type: "single",
          options: opts("A", "B"),
          correct_answers: ["A"],
          image_url: "",
        },
      ] as CreateQuestionDto[]);
      expect(insertedRows().map((r) => r.image_url)).toEqual([
        "https://cdn.example/a.png",
        null,
      ]);
    });

    it("refuse une question invalide pour son type (400, numéro de question)", async () => {
      mockAdd();
      await expect(
        service.addQuestions("quiz1", OWNER, [
          {
            ...base,
            type: "single",
            options: opts("A", "B"),
            correct_answers: ["A"],
          },
          {
            ...base,
            type: "ordering",
            options: opts("A", "B"),
            correct_answers: ["A", "B"],
          },
        ] as CreateQuestionDto[]),
      ).rejects.toThrow(/Question 2 : .*entre 3 et 6/);
      expect(insertedRows()).toEqual([]);
    });
  });

  describe("createImageUploadUrl", () => {
    it("renvoie une URL signée pour un chemin imposé par le serveur", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const result = await service.createImageUploadUrl("quiz1", OWNER, {
        content_type: "image/webp",
        size: 150_000,
      });

      expect(storageFrom).toHaveBeenCalledWith(QUESTION_IMAGES_BUCKET);
      const path = storageBucket.createSignedUploadUrl.mock.calls[0][0];
      expect(path).toMatch(
        /^quiz1\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/,
      );
      expect(result).toEqual({
        upload_url: expect.stringContaining("/object/upload/sign/"),
        token: "tok",
        path,
        bucket: "question-images",
        public_url: `https://proj.supabase.co/storage/v1/object/public/question-images/${path}`,
        content_type: "image/webp",
        max_bytes: 2 * 1024 * 1024,
        expires_in: 7200,
      });
    });

    it.each([
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/gif", "gif"],
    ])("extension pour %s", async (type, ext) => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      const result = await service.createImageUploadUrl("quiz1", OWNER, {
        content_type: type as any,
        size: 10,
      });
      expect(result.path.endsWith(`.${ext}`)).toBe(true);
    });

    it("refuse un type non accepté, sans URL signée", async () => {
      for (const type of ["image/svg+xml", "text/html", undefined]) {
        await expect(
          service.createImageUploadUrl("quiz1", OWNER, {
            content_type: type as any,
            size: 10,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(storageBucket.createSignedUploadUrl).not.toHaveBeenCalled();
    });

    it("refuse une taille supérieure à 2 Mo (ou invalide), sans URL signée", async () => {
      for (const size of [2 * 1024 * 1024 + 1, 0, NaN, 1.5]) {
        await expect(
          service.createImageUploadUrl("quiz1", OWNER, {
            content_type: "image/png",
            size,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(storageBucket.createSignedUploadUrl).not.toHaveBeenCalled();
    });

    it("404 pour un quiz d'un autre créateur, sans URL signée", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      await expect(
        service.createImageUploadUrl("quiz1", OTHER, {
          content_type: "image/png",
          size: 10,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storageBucket.createSignedUploadUrl).not.toHaveBeenCalled();
    });

    it("propage une erreur Storage (bucket absent, par exemple)", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      storageBucket.createSignedUploadUrl.mockResolvedValueOnce({
        data: null,
        error: { message: "Bucket not found" },
      });
      await expect(
        service.createImageUploadUrl("quiz1", OWNER, {
          content_type: "image/png",
          size: 10,
        }),
      ).rejects.toThrow("Bucket not found");
    });
  });

  describe("import Markdown étendu", () => {
    const mockImport = () =>
      supabase
        .mockResponse("quizzes", { data: { creator_id: OWNER } }) // import
        .mockResponse("quizzes", { data: { creator_id: OWNER } }) // addQuestions
        .mockResponse("questions", { data: [] })
        .mockResponse("questions", { data: [] });

    it("importe images et marqueurs de type", async () => {
      mockImport();
      await service.importFromMarkdown("quiz1", OWNER, {
        questions_content: [
          "Quiz: Démo",
          "",
          "Question 1 [timer:20] [points:100]",
          "Capitale de la France ?",
          "![Carte de France](https://cdn.example/france.png)",
          "A) Lyon",
          "B) Paris [correct]",
          "",
          "Question 2 [type: true_false] [points:50]",
          "La Terre est plate.",
          "= faux",
          "> Explication : Elle est (presque) sphérique.",
          "",
          "Question 3 [type: ordering] [timer:40]",
          "Rangez du plus petit au plus grand",
          "A) Souris",
          "B) Chat",
          "C) Cheval",
          "D) Baleine",
          "",
          "Question 4 [type: short_answer]",
          "Capitale de l'Italie ?",
          "= Rome",
          "= Roma",
          "",
          "Question 5 [type:poll]",
          "Votre saison préférée ?",
          "A) Printemps",
          "B) Été",
          "C) Automne",
          "D) Hiver",
          "E) Aucune",
          "",
          "Question 6 [type: multiple]",
          "Une seule bonne réponse mais type multiple",
          "A) Oui [correct]",
          "B) Non",
        ].join("\n"),
      });

      const rows = insertedRows();
      expect(rows).toHaveLength(6);
      expect(rows[0]).toMatchObject({
        type: "single",
        correct_answers: ["B"],
        image_url: "https://cdn.example/france.png",
        timer_seconds: 20,
      });
      expect(rows[1]).toMatchObject({
        type: "true_false",
        text: "La Terre est plate.",
        options: [
          { id: "true", text: "Vrai" },
          { id: "false", text: "Faux" },
        ],
        correct_answers: ["false"],
        max_points: 50,
        explanation: "Elle est (presque) sphérique.",
        image_url: null,
      });
      expect(rows[2]).toMatchObject({ type: "ordering", timer_seconds: 40 });
      const byId = new Map(rows[2].options.map((o: any) => [o.id, o.text]));
      expect(rows[2].correct_answers.map((id: string) => byId.get(id))).toEqual(
        ["Souris", "Chat", "Cheval", "Baleine"],
      );
      expect(rows[3]).toMatchObject({
        type: "short_answer",
        options: [],
        correct_answers: ["Rome", "Roma"],
      });
      expect(rows[4]).toMatchObject({
        type: "poll",
        correct_answers: [],
      });
      expect(rows[4].options).toHaveLength(5);
      expect(rows[5]).toMatchObject({
        type: "multiple",
        correct_answers: ["A"],
      });
    });

    it("refuse un type inconnu", async () => {
      mockImport();
      await expect(
        service.importFromMarkdown("quiz1", OWNER, {
          questions_content: "Question 1 [type: essay]\nTexte\nA) a\nB) b",
        }),
      ).rejects.toThrow(/type inconnu "essay"/);
    });

    it("refuse une question typée invalide (true_false sans réponse, short_answer sans variante)", async () => {
      mockImport();
      await expect(
        service.importFromMarkdown("quiz1", OWNER, {
          questions_content: "Question 1 [type: true_false]\nLe ciel est bleu.",
        }),
      ).rejects.toThrow(/Question 1 : .*\["true"\]/);

      supabase.reset();
      mockImport();
      await expect(
        service.importFromMarkdown("quiz1", OWNER, {
          questions_content: "Question 1 [type: short_answer]\nCapitale ?",
        }),
      ).rejects.toThrow(/Question 1 : .*variantes/);
    });

    it("accepte une image placée avant l'énoncé", async () => {
      mockImport();
      await service.importFromMarkdown("quiz1", OWNER, {
        questions_content: [
          "Question 1",
          "![](https://cdn.example/a.gif)",
          "Texte après l'image",
          "A) a [correct]",
          "B) b",
        ].join("\n"),
      });
      expect(insertedRows()[0]).toMatchObject({
        text: "Texte après l'image",
        image_url: "https://cdn.example/a.gif",
      });
    });

    it("refuse une image dont l'URL n'est pas http(s)", async () => {
      mockImport();
      await expect(
        service.importFromMarkdown("quiz1", OWNER, {
          questions_content: [
            "Question 1",
            "Texte",
            "![](javascript:alert(1))",
            "A) a [correct]",
            "B) b",
          ].join("\n"),
        }),
      ).rejects.toThrow(/Question 1 : image_url/);
    });

    it("le fichier de réponses ne modifie pas une question typée non-choix", async () => {
      mockImport();
      await service.importFromMarkdown("quiz1", OWNER, {
        questions_content: [
          "Question 1",
          "Choix ?",
          "A) a",
          "B) b",
          "",
          "Question 2 [type: poll]",
          "Sondage ?",
          "A) x",
          "B) y",
        ].join("\n"),
        answers_content: "## Question 1\nB\n\n## Question 2\nA\n",
      });
      const rows = insertedRows();
      expect(rows[0]).toMatchObject({ type: "single", correct_answers: ["B"] });
      expect(rows[1]).toMatchObject({ type: "poll", correct_answers: [] });
    });
  });
});
