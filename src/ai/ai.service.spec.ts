import { HttpException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Anthropic from "@anthropic-ai/sdk";
import { AiService, UploadedPdf } from "./ai.service";
import { AiQuotaService } from "./ai-quota.service";
import { PdfTextExtractor, UnreadablePdfError } from "./pdf-text";
import { GenerateQuizDto } from "./dto/generate-quiz.dto";
import { AI_MAX_SOURCE_CHARS } from "./ai.constants";
import { createSupabaseMock } from "../test-utils/supabase.mock";

/**
 * Client Anthropic entièrement mocké : aucun appel réseau en test ni en CI.
 */
function mockClient() {
  const create = jest.fn();
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return { client, create };
}

function modelResponse(
  payload: unknown,
  stop_reason = "end_turn",
): Record<string, unknown> {
  return {
    stop_reason,
    content: [
      { type: "thinking", thinking: "" },
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    ],
  };
}

const COURSE =
  "La photosynthèse est le processus par lequel les plantes vertes utilisent l'énergie lumineuse pour produire de la matière organique à partir de dioxyde de carbone et d'eau. Elle libère du dioxygène et se déroule dans les chloroplastes.";

const validQuestion = (text = "Où se déroule la photosynthèse ?") => ({
  text,
  type: "single",
  options: [
    { id: "A", text: "Dans les chloroplastes" },
    { id: "B", text: "Dans les racines" },
  ],
  correct_answers: ["A"],
  explanation: "Le cours indique les chloroplastes.",
});

function dto(overrides: Partial<GenerateQuizDto> = {}): GenerateQuizDto {
  return Object.assign(new GenerateQuizDto(), {
    text: COURSE,
    level: "4e",
    count: 2,
    ...overrides,
  });
}

function pdfFile(overrides: Partial<UploadedPdf> = {}): UploadedPdf {
  const buffer = Buffer.from("%PDF-1.4\n...");
  return {
    originalname: "cours.pdf",
    mimetype: "application/pdf",
    size: buffer.length,
    buffer,
    ...overrides,
  };
}

function setup(
  options: {
    withClient?: boolean;
    env?: Record<string, string>;
    used?: number;
  } = {},
) {
  const { withClient = true, env = {}, used = 0 } = options;
  const supabase = createSupabaseMock();
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const quota = new AiQuotaService(supabase.client, config);
  const pdf = {
    extract: jest.fn(),
  } as unknown as jest.Mocked<PdfTextExtractor>;
  const { client, create } = mockClient();
  const service = new AiService(withClient ? client : null, quota, pdf, config);
  // assertAvailable (count) puis reserve (insert + count)
  supabase
    .mockResponse("ai_generations", { count: used })
    .mockResponse("ai_generations", { data: { id: "gen-1" } })
    .mockResponse("ai_generations", { count: used + 1 });
  return { service, create, supabase, pdf };
}

/** Requêtes de suppression (annulation de la réservation) sur ai_generations. */
function releases(supabase: ReturnType<typeof createSupabaseMock>) {
  return supabase
    .queriesFor("ai_generations")
    .filter((q) => q.calls.some((c) => c.method === "delete"));
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  const error = await promise.then(
    () => {
      throw new Error("la promesse aurait dû échouer");
    },
    (e) => e,
  );
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(status);
  return error as HttpException;
}

describe("AiService.generate (issue #11)", () => {
  it("503 avec un message clair si ANTHROPIC_API_KEY est absente", async () => {
    const { service, supabase } = setup({ withClient: false });
    const error = await expectStatus(service.generate("u1", dto()), 503);
    expect(error.message).toContain("ANTHROPIC_API_KEY");
    expect(supabase.queries).toHaveLength(0);
  });

  it("génère un brouillon depuis un texte, sans rien enregistrer d'autre que le quota", async () => {
    const { service, create, supabase } = setup({
      env: { AI_MODEL: "claude-sonnet-5-5" },
    });
    create.mockResolvedValue(
      modelResponse({ questions: [validQuestion(), validQuestion("Q2 ?")] }),
    );

    const result = await service.generate(
      "u1",
      dto({ types: ["single", "true_false"] }),
    );

    expect(result).toMatchObject({
      requested: 2,
      generated: 2,
      rejected: 0,
      model: "claude-sonnet-5-5",
      source: { type: "text", truncated: false },
      quota: { limit: 3, used: 1, remaining: 2 },
    });
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0]).toMatchObject({ max_points: 100 });

    const request = create.mock.calls[0][0];
    expect(request.model).toBe("claude-sonnet-5-5");
    expect(request.max_tokens).toBe(16000);
    expect(request.output_config.format.type).toBe("json_schema");
    expect(
      request.output_config.format.schema.properties.questions.items.properties
        .type.enum,
    ).toEqual(["single", "true_false"]);
    expect(request.messages[0].content).toContain("<document>");
    expect(request.messages[0].content).toContain("chloroplastes");
    expect(request.messages[0].content).toContain("Niveau de la classe : 4e");
    expect(request.system).toContain("UNIQUEMENT sur le document fourni");
    // repli serveur en cas de refus du modèle
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(request.fallbacks).toBe("default");

    // seules tables touchées : ai_generations (count, insert, count, update)
    expect(new Set(supabase.queries.map((q) => q.table))).toEqual(
      new Set(["ai_generations"]),
    );
    expect(releases(supabase)).toHaveLength(0);
    const update = supabase
      .queriesFor("ai_generations")
      .find((q) => q.calls[0].method === "update");
    expect(update?.calls[0].args[0]).toEqual({ question_count: 2 });
  });

  it("modèle par défaut claude-sonnet-5-5 ; AI_MODEL respecté", async () => {
    const a = setup();
    a.create.mockResolvedValue(modelResponse({ questions: [validQuestion()] }));
    await a.service.generate("u1", dto());
    expect(a.create.mock.calls[0][0].model).toBe("claude-sonnet-5-5");
    expect(
      a.create.mock.calls[0][0].output_config.format.schema.properties.questions
        .items.properties.type.enum,
    ).toEqual(["single", "multiple", "true_false"]);

    const b = setup({ env: { AI_MODEL: "claude-haiku-5-5" } });
    b.create.mockResolvedValue(modelResponse({ questions: [validQuestion()] }));
    await b.service.generate("u1", dto());
    const request = b.create.mock.calls[0][0];
    expect(request.model).toBe("claude-haiku-5-5");
  });

  it("écarte les questions invalides et les compte", async () => {
    const { service, create } = setup();
    create.mockResolvedValue(
      modelResponse({
        questions: [
          validQuestion(),
          { ...validQuestion("Incohérente"), correct_answers: ["A", "B"] },
          { ...validQuestion("Hors options"), correct_answers: ["D"] },
        ],
      }),
    );
    const result = await service.generate("u1", dto({ count: 3 }));
    expect(result.questions).toHaveLength(1);
    expect(result.generated).toBe(3);
    expect(result.rejected).toBe(2);
  });

  it("502 et quota non consommé si la sortie JSON est malformée", async () => {
    const { service, create, supabase } = setup();
    create.mockResolvedValue(modelResponse('{"questions": [ {"text": '));
    await expectStatus(service.generate("u1", dto()), 502);
    expect(releases(supabase)).toHaveLength(1);
    expect(releases(supabase)[0].calls).toContainEqual({
      method: "eq",
      args: ["id", "gen-1"],
    });
  });

  it("502 et quota non consommé si aucune question n'est valide", async () => {
    const { service, create, supabase } = setup();
    create.mockResolvedValue(
      modelResponse({
        questions: [{ ...validQuestion(), correct_answers: [] }],
      }),
    );
    await expectStatus(service.generate("u1", dto()), 502);
    expect(releases(supabase)).toHaveLength(1);
  });

  it("504 et quota non consommé en cas de délai d'attente dépassé", async () => {
    const { service, create, supabase } = setup();
    create.mockRejectedValue(new Anthropic.APIConnectionTimeoutError());
    await expectStatus(service.generate("u1", dto()), 504);
    expect(releases(supabase)).toHaveLength(1);
  });

  it("503 et quota non consommé si le fournisseur est surchargé", async () => {
    const { service, create, supabase } = setup();
    create.mockRejectedValue(
      new Anthropic.RateLimitError(
        429,
        undefined,
        "rate limited",
        new Headers(),
      ),
    );
    await expectStatus(service.generate("u1", dto()), 503);
    expect(releases(supabase)).toHaveLength(1);
  });

  it("503 si la clé est refusée par le fournisseur, sans journaliser la clé", async () => {
    const { service, create } = setup();
    const logSpy = jest
      .spyOn((service as any).logger, "error")
      .mockImplementation(() => undefined);
    create.mockRejectedValue(
      new Anthropic.AuthenticationError(
        401,
        undefined,
        "invalid x-api-key",
        new Headers(),
      ),
    );
    await expectStatus(service.generate("u1", dto()), 503);
    expect(logSpy).toHaveBeenCalled();
    for (const call of logSpy.mock.calls) {
      expect(String(call[0])).not.toMatch(/sk-ant/);
    }
  });

  it("422 et quota non consommé si le modèle refuse", async () => {
    const { service, create, supabase } = setup();
    create.mockResolvedValue(modelResponse("", "refusal"));
    await expectStatus(service.generate("u1", dto()), 422);
    expect(releases(supabase)).toHaveLength(1);
  });

  it("429 si le quota est atteint, sans appeler l'IA", async () => {
    const { service, create } = setup({ used: 3 });
    const error = await expectStatus(service.generate("u1", dto()), 429);
    expect((error.getResponse() as any).quota).toMatchObject({
      limit: 3,
      used: 3,
      remaining: 0,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("respecte AI_MONTHLY_QUOTA", async () => {
    const { service, create } = setup({
      used: 3,
      env: { AI_MONTHLY_QUOTA: "5" },
    });
    create.mockResolvedValue(modelResponse({ questions: [validQuestion()] }));
    const result = await service.generate("u1", dto());
    expect(result.quota).toMatchObject({ limit: 5, used: 4, remaining: 1 });
  });

  it("tronque un texte trop long à 60 000 caractères et le signale", async () => {
    const { service, create } = setup();
    create.mockResolvedValue(modelResponse({ questions: [validQuestion()] }));
    const long = `${"Paragraphe du cours. ".repeat(4000)}FIN-DU-COURS`;
    const result = await service.generate("u1", dto({ text: long }));
    expect(result.source).toEqual({
      type: "text",
      chars: long.length,
      used_chars: AI_MAX_SOURCE_CHARS,
      truncated: true,
    });
    const prompt: string = create.mock.calls[0][0].messages[0].content;
    expect(prompt).not.toContain("FIN-DU-COURS");
    expect(prompt.length).toBeLessThan(AI_MAX_SOURCE_CHARS + 1000);
  });

  it("422 si le texte est trop court", async () => {
    const { service, create } = setup();
    await expectStatus(
      service.generate("u1", dto({ text: "Trop court." })),
      422,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("400 si ni texte ni PDF, ou les deux", async () => {
    const { service } = setup();
    await expectStatus(service.generate("u1", dto({ text: undefined })), 400);
    await expectStatus(service.generate("u1", dto({ text: "   " })), 400);
    await expectStatus(service.generate("u1", dto(), pdfFile()), 400);
  });

  describe("PDF", () => {
    it("génère depuis un PDF (texte extrait côté serveur)", async () => {
      const { service, create, pdf } = setup();
      pdf.extract.mockResolvedValue(COURSE);
      create.mockResolvedValue(modelResponse({ questions: [validQuestion()] }));
      const result = await service.generate(
        "u1",
        dto({ text: undefined }),
        pdfFile(),
      );
      expect(result.source.type).toBe("pdf");
      expect(pdf.extract).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0].messages[0].content).toContain(
        "chloroplastes",
      );
    });

    it("415 si le type MIME n'est pas application/pdf", async () => {
      const { service, pdf } = setup();
      await expectStatus(
        service.generate(
          "u1",
          dto({ text: undefined }),
          pdfFile({ mimetype: "image/png" }),
        ),
        415,
      );
      expect(pdf.extract).not.toHaveBeenCalled();
    });

    it("415 si la signature %PDF est absente (type MIME usurpé)", async () => {
      const { service, pdf } = setup();
      const buffer = Buffer.from("MZ\u0090\u0000 exécutable déguisé");
      await expectStatus(
        service.generate(
          "u1",
          dto({ text: undefined }),
          pdfFile({ buffer, size: buffer.length }),
        ),
        415,
      );
      expect(pdf.extract).not.toHaveBeenCalled();
    });

    it("413 si le PDF dépasse 10 Mo", async () => {
      const { service } = setup();
      await expectStatus(
        service.generate(
          "u1",
          dto({ text: undefined }),
          pdfFile({ size: 10 * 1024 * 1024 + 1 }),
        ),
        413,
      );
    });

    it("422 explicite si le PDF n'a pas de texte extractible (scanné)", async () => {
      const { service, create, pdf } = setup();
      pdf.extract.mockResolvedValue("  \n \n ");
      const error = await expectStatus(
        service.generate("u1", dto({ text: undefined }), pdfFile()),
        422,
      );
      expect(error.message).toContain("pas de texte extractible");
      expect(create).not.toHaveBeenCalled();
    });

    it("422 si le PDF est illisible", async () => {
      const { service, pdf } = setup();
      pdf.extract.mockRejectedValue(new UnreadablePdfError("bad xref"));
      await expectStatus(
        service.generate("u1", dto({ text: undefined }), pdfFile()),
        422,
      );
    });
  });
});
