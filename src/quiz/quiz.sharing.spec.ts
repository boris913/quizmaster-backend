import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { QuizController } from "./quiz.controller";
import {
  QUESTION_IMAGES_BUCKET,
  QuizService,
  SHARE_TOKEN_PATTERN,
} from "./quiz.service";

const OWNER = "user-owner";
const OTHER = "user-other";
const SOURCE_ID = "11111111-1111-1111-1111-111111111111";
const NEW_ID = "22222222-2222-2222-2222-222222222222";
const PUBLIC_BASE =
  "https://proj.supabase.co/storage/v1/object/public/question-images/";
const IMG_PATH = `${SOURCE_ID}/33333333-3333-3333-3333-333333333333.png`;
const TOKEN = "abcdefghijklmnopqrstuvwxyzABCD_-";

const sourceQuiz = {
  id: SOURCE_ID,
  creator_id: OWNER,
  title: "Géographie",
  description: "Capitales",
  global_timer_seconds: 25,
  use_global_timer: false,
  share_token: TOKEN,
};

/** Questions telles qu'enregistrées (ordering : ids déjà réattribués). */
const sourceQuestions = [
  {
    id: "q1",
    quiz_id: SOURCE_ID,
    text: "Capitale de la France ?",
    type: "single",
    options: [
      { id: "A", text: "Lyon" },
      { id: "B", text: "Paris" },
    ],
    correct_answers: ["B"],
    max_points: 100,
    timer_seconds: 30,
    explanation: "Depuis longtemps.",
    image_url: `${PUBLIC_BASE}${IMG_PATH}`,
    order_index: 0,
  },
  {
    id: "q2",
    quiz_id: SOURCE_ID,
    text: "Du plus petit au plus grand",
    type: "ordering",
    options: [
      { id: "A", text: "100" },
      { id: "B", text: "1" },
      { id: "C", text: "10" },
    ],
    correct_answers: ["B", "C", "A"],
    max_points: 100,
    timer_seconds: 45,
    explanation: null,
    image_url: "https://example.org/externe.png",
    order_index: 1,
  },
  {
    id: "q3",
    quiz_id: SOURCE_ID,
    text: "Symbole de l'or ?",
    type: "short_answer",
    options: [],
    correct_answers: ["Au"],
    max_points: 50,
    timer_seconds: 20,
    explanation: null,
    image_url: null,
    order_index: 2,
  },
  {
    id: "q4",
    quiz_id: SOURCE_ID,
    text: "Vrai ?",
    type: "true_false",
    options: [
      { id: "true", text: "Vrai" },
      { id: "false", text: "Faux" },
    ],
    correct_answers: ["false"],
    max_points: 100,
    timer_seconds: 10,
    explanation: null,
    image_url: null,
    order_index: 3,
  },
];

describe("QuizService : duplication et partage (issue #12)", () => {
  let service: QuizService;
  let supabase: SupabaseMock;
  let bucket: { getPublicUrl: jest.Mock; copy: jest.Mock; remove: jest.Mock };

  beforeEach(async () => {
    supabase = createSupabaseMock();
    bucket = {
      getPublicUrl: jest.fn((path: string) => ({
        data: { publicUrl: `${PUBLIC_BASE}${path}` },
      })),
      copy: jest.fn(async () => ({ data: { path: "x" }, error: null })),
      remove: jest.fn(async () => ({ data: [], error: null })),
    };
    const client = Object.assign(Object.create(null), supabase.client, {
      storage: { from: jest.fn(() => bucket) },
    });
    const moduleRef = await Test.createTestingModule({
      providers: [QuizService, { provide: SUPABASE_CLIENT, useValue: client }],
    }).compile();
    service = moduleRef.get(QuizService);
  });

  const calls = (table: string, method: string) =>
    supabase
      .queriesFor(table)
      .flatMap((q) => q.calls)
      .filter((c) => c.method === method);

  const insertedQuestions = (): any[] =>
    (calls("questions", "insert")[0]?.args[0] as any[]) ?? [];

  /** File de réponses d'une copie complète (source déjà lue par l'appelant). */
  const mockCopy = (owner: string, questions = sourceQuestions) =>
    supabase
      .mockResponse("questions", { data: questions })
      .mockResponse("quizzes", {
        data: { id: NEW_ID, creator_id: owner, title: "x" },
      })
      .mockResponse("questions", { data: [] })
      .mockResponse("questions", { data: questions.map((q) => ({ ...q })) })
      .mockResponse("quizzes", {
        data: { id: NEW_ID, creator_id: owner, title: "x" },
      })
      .mockResponse("questions", { data: [] });

  describe("duplicateQuiz", () => {
    it("copie le quiz et ses questions dans l'ordre, types conservés, lien source", async () => {
      supabase.mockResponse("quizzes", { data: sourceQuiz });
      mockCopy(OWNER);

      const result = await service.duplicateQuiz(SOURCE_ID, OWNER);

      const quizInsert = calls("quizzes", "insert")[0].args[0] as any;
      expect(quizInsert).toEqual({
        creator_id: OWNER,
        title: "Géographie (copie)",
        description: "Capitales",
        global_timer_seconds: 25,
        use_global_timer: false,
        source_quiz_id: SOURCE_ID,
      });
      expect(quizInsert).not.toHaveProperty("share_token");

      const rows = insertedQuestions();
      expect(rows.map((r) => [r.text, r.type, r.order_index])).toEqual([
        ["Capitale de la France ?", "single", 0],
        ["Du plus petit au plus grand", "ordering", 1],
        ["Symbole de l'or ?", "short_answer", 2],
        ["Vrai ?", "true_false", 3],
      ]);
      expect(rows.every((r) => r.quiz_id === NEW_ID)).toBe(true);
      expect(rows[0]).toMatchObject({
        correct_answers: ["B"],
        explanation: "Depuis longtemps.",
      });
      expect(rows[2]).toMatchObject({ options: [], correct_answers: ["Au"] });
      expect(rows[3].correct_answers).toEqual(["false"]);
      expect(result.warnings).toEqual([]);
      expect(result.quiz).toMatchObject({ id: NEW_ID });
    });

    it("ordering : ids réattribués mais ordre attendu identique (question jouable)", async () => {
      for (let i = 0; i < 10; i++) {
        supabase.reset();
        supabase.mockResponse("quizzes", { data: sourceQuiz });
        mockCopy(OWNER);
        await service.duplicateQuiz(SOURCE_ID, OWNER);
        const ordering = insertedQuestions()[1];
        const textOf = (id: string) =>
          ordering.options.find((o: any) => o.id === id)?.text;
        expect(ordering.correct_answers.map(textOf)).toEqual(["1", "10", "100"]);
        expect([...ordering.options.map((o: any) => o.id)].sort()).toEqual([
          "A",
          "B",
          "C",
        ]);
      }
    });

    it("copie les images du bucket dans le dossier du nouveau quiz, garde les images externes", async () => {
      supabase.mockResponse("quizzes", { data: sourceQuiz });
      mockCopy(OWNER);

      await service.duplicateQuiz(SOURCE_ID, OWNER);

      expect(bucket.copy).toHaveBeenCalledTimes(1);
      const [from, to] = bucket.copy.mock.calls[0];
      expect(from).toBe(IMG_PATH);
      expect(to).toMatch(new RegExp(`^${NEW_ID}/[0-9a-f-]{36}\\.png$`));
      const rows = insertedQuestions();
      expect(rows[0].image_url).toBe(`${PUBLIC_BASE}${to}`);
      expect(rows[1].image_url).toBe("https://example.org/externe.png");
    });

    it("copie d'image échouée : question gardée sans image et signalée", async () => {
      bucket.copy.mockResolvedValueOnce({
        data: null,
        error: { message: "Object not found" },
      });
      supabase.mockResponse("quizzes", { data: sourceQuiz });
      mockCopy(OWNER);

      const result = await service.duplicateQuiz(SOURCE_ID, OWNER);

      expect(insertedQuestions()[0].image_url).toBeNull();
      expect(insertedQuestions()).toHaveLength(4);
      expect(result.warnings).toEqual([
        {
          question_number: 1,
          message: expect.stringContaining("image non copiée"),
        },
      ]);
    });

    it("une question enregistrée invalide n'est pas copiée et est signalée", async () => {
      const broken = { ...sourceQuestions[2], correct_answers: [] };
      supabase.mockResponse("quizzes", { data: sourceQuiz });
      mockCopy(OWNER, [sourceQuestions[0], broken]);

      const result = await service.duplicateQuiz(SOURCE_ID, OWNER);

      expect(insertedQuestions()).toHaveLength(1);
      expect(result.warnings).toEqual([
        {
          question_number: 2,
          message: expect.stringContaining("question non copiée"),
        },
      ]);
    });

    it("échec d'insertion des questions : quiz et images copiées supprimés", async () => {
      supabase
        .mockResponse("quizzes", { data: sourceQuiz })
        .mockResponse("questions", { data: sourceQuestions })
        .mockResponse("quizzes", { data: { id: NEW_ID, creator_id: OWNER } })
        .mockResponse("questions", { data: [] })
        .mockResponse("questions", { error: { message: "boom" } });

      await expect(service.duplicateQuiz(SOURCE_ID, OWNER)).rejects.toThrow(
        /boom/,
      );
      expect(calls("quizzes", "delete")).toHaveLength(1);
      expect(bucket.remove).toHaveBeenCalledWith([
        expect.stringMatching(new RegExp(`^${NEW_ID}/`)),
      ]);
    });

    it("404 si le quiz appartient à un autre utilisateur ou n'existe pas", async () => {
      supabase.mockResponse("quizzes", { data: sourceQuiz });
      await expect(service.duplicateQuiz(SOURCE_ID, OTHER)).rejects.toThrow(
        NotFoundException,
      );
      supabase.mockResponse("quizzes", { data: null });
      await expect(service.duplicateQuiz(SOURCE_ID, OWNER)).rejects.toThrow(
        NotFoundException,
      );
      expect(calls("quizzes", "insert")).toHaveLength(0);
    });

    it("tronque le titre pour rester sous 200 caractères", async () => {
      supabase.mockResponse("quizzes", {
        data: { ...sourceQuiz, title: "x".repeat(200) },
      });
      mockCopy(OWNER, []);
      await service.duplicateQuiz(SOURCE_ID, OWNER);
      const title = (calls("quizzes", "insert")[0].args[0] as any).title;
      expect(title).toHaveLength(200);
      expect(title.endsWith(" (copie)")).toBe(true);
    });
  });

  describe("lien de partage", () => {
    it("crée un jeton aléatoire de 32 caractères, différent à chaque régénération", async () => {
      supabase
        .mockResponse("quizzes", { data: { creator_id: OWNER } })
        .mockResponse("quizzes", { data: null })
        .mockResponse("quizzes", { data: { creator_id: OWNER } })
        .mockResponse("quizzes", { data: null });

      const first = await service.createShareLink(SOURCE_ID, OWNER);
      const second = await service.createShareLink(SOURCE_ID, OWNER);

      expect(first.share_token).toMatch(SHARE_TOKEN_PATTERN);
      expect(second.share_token).toMatch(SHARE_TOKEN_PATTERN);
      expect(second.share_token).not.toBe(first.share_token);
      const updates = calls("quizzes", "update").map((c) => c.args[0]);
      expect(updates).toEqual([
        { share_token: first.share_token },
        { share_token: second.share_token },
      ]);
    });

    it("régénère en cas de collision de jeton (23505)", async () => {
      supabase
        .mockResponse("quizzes", { data: { creator_id: OWNER } })
        .mockResponse("quizzes", {
          error: { message: "duplicate", code: "23505" },
        })
        .mockResponse("quizzes", { data: null });
      const { share_token } = await service.createShareLink(SOURCE_ID, OWNER);
      expect(share_token).toMatch(SHARE_TOKEN_PATTERN);
      expect(calls("quizzes", "update")).toHaveLength(2);
    });

    it("révoque le lien (share_token remis à null)", async () => {
      supabase.mockResponse("quizzes", { data: { creator_id: OWNER } });
      await expect(service.revokeShareLink(SOURCE_ID, OWNER)).resolves.toEqual(
        { share_token: null },
      );
      expect(calls("quizzes", "update")[0].args[0]).toEqual({
        share_token: null,
      });
    });

    it("seul le propriétaire peut partager ou révoquer (404 sinon)", async () => {
      supabase
        .mockResponse("quizzes", { data: { creator_id: OWNER } })
        .mockResponse("quizzes", { data: { creator_id: OWNER } });
      await expect(service.createShareLink(SOURCE_ID, OTHER)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.revokeShareLink(SOURCE_ID, OTHER)).rejects.toThrow(
        NotFoundException,
      );
      expect(calls("quizzes", "update")).toHaveLength(0);
    });
  });

  describe("aperçu public", () => {
    it("ne renvoie ni bonnes réponses ni explications (colonnes non lues)", async () => {
      supabase
        .mockResponse("quizzes", { data: sourceQuiz })
        .mockResponse("questions", { data: sourceQuestions });

      const preview = await service.getSharedQuiz(TOKEN);

      const quizQuery = supabase.queriesFor("quizzes")[0].calls;
      expect(quizQuery).toContainEqual({
        method: "eq",
        args: ["share_token", TOKEN],
      });
      const select = supabase.queriesFor("questions")[0].calls[0]
        .args[0] as string;
      expect(select).not.toMatch(/correct_answers|explanation|\*/);

      expect(preview.question_count).toBe(4);
      const json = JSON.stringify(preview);
      expect(json).not.toMatch(/correct_answers|explanation|Depuis longtemps/);
      expect(json).not.toContain(OWNER);
      expect(preview).not.toHaveProperty("id");
      expect(preview).not.toHaveProperty("creator_id");
      expect(preview).not.toHaveProperty("share_token");
      expect(preview.questions[0]).toEqual({
        position: 1,
        text: "Capitale de la France ?",
        type: "single",
        options: [
          { id: "A", text: "Lyon" },
          { id: "B", text: "Paris" },
        ],
        image_url: `${PUBLIC_BASE}${IMG_PATH}`,
        max_points: 100,
        timer_seconds: 30,
      });
    });

    it("jeton révoqué ou inconnu → 404", async () => {
      supabase.mockResponse("quizzes", { data: null });
      await expect(service.getSharedQuiz(TOKEN)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("jeton mal formé → 404 sans requête", async () => {
      await expect(service.getSharedQuiz("court")).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        service.getSharedQuiz("a".repeat(31) + "%"),
      ).rejects.toThrow(NotFoundException);
      expect(supabase.queries).toHaveLength(0);
    });
  });

  describe("copie depuis un lien de partage", () => {
    it("un autre utilisateur obtient une copie indépendante dans son compte", async () => {
      supabase.mockResponse("quizzes", { data: sourceQuiz });
      mockCopy(OTHER);

      const result = await service.copySharedQuiz(TOKEN, OTHER);

      const quizInsert = calls("quizzes", "insert")[0].args[0] as any;
      expect(quizInsert).toMatchObject({
        creator_id: OTHER,
        title: "Géographie",
        source_quiz_id: SOURCE_ID,
      });
      expect(insertedQuestions()).toHaveLength(4);
      expect(insertedQuestions().every((r) => r.quiz_id === NEW_ID)).toBe(true);
      // L'original n'est jamais modifié
      expect(calls("quizzes", "update")).toHaveLength(0);
      expect(
        supabase
          .queriesFor("questions")
          .flatMap((q) => q.calls)
          .some((c) => c.method === "update" || c.method === "delete"),
      ).toBe(false);
      expect(bucket.copy.mock.calls[0][1]).toMatch(new RegExp(`^${NEW_ID}/`));
      expect(result.quiz).toMatchObject({ id: NEW_ID, creator_id: OTHER });
    });

    it("jeton révoqué → 404, rien n'est créé", async () => {
      supabase.mockResponse("quizzes", { data: null });
      await expect(service.copySharedQuiz(TOKEN, OTHER)).rejects.toThrow(
        NotFoundException,
      );
      expect(calls("quizzes", "insert")).toHaveLength(0);
    });
  });

  it("utilise le bucket des images de question", async () => {
    supabase.mockResponse("quizzes", { data: sourceQuiz });
    mockCopy(OWNER);
    await service.duplicateQuiz(SOURCE_ID, OWNER);
    const client = (service as any).supabase;
    expect(client.storage.from).toHaveBeenCalledWith(QUESTION_IMAGES_BUCKET);
  });
});

describe("QuizController : ordre des routes (issue #12)", () => {
  it("déclare les routes fixes avant GET :id", () => {
    const names = Object.getOwnPropertyNames(QuizController.prototype);
    const getQuiz = names.indexOf("getQuiz");
    expect(names.indexOf("getImportTemplate")).toBeLessThan(getQuiz);
    expect(names.indexOf("getSharedQuiz")).toBeLessThan(getQuiz);
  });
});
