import { request as httpRequest } from "http";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { GLOBAL_VALIDATION_OPTIONS } from "../common/validation";

/**
 * Tests HTTP de `POST /api/quizzes/generate` : vraie application Nest
 * (garde JWT, multer, ValidationPipe globale), AiService mocké.
 */
jest.setTimeout(60_000);

describe("POST /api/quizzes/generate (HTTP, issue #11)", () => {
  const SECRET = "test-secret";
  let app: INestApplication;
  let baseUrl: string;
  let token: string;
  const aiService = {
    generate: jest.fn().mockResolvedValue({ questions: [] }),
    getQuota: jest.fn().mockResolvedValue({ limit: 3, used: 0 }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AiController],
      providers: [
        { provide: AiService, useValue: aiService },
        { provide: JwtService, useValue: new JwtService({ secret: SECRET }) },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) => (k === "JWT_SECRET" ? SECRET : undefined),
          },
        },
        Reflector,
        JwtAuthGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe(GLOBAL_VALIDATION_OPTIONS));
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}/api/quizzes/generate`;
    token = await new JwtService({ secret: SECRET }).signAsync({
      sub: "user-1",
      pseudo: "prof",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  function form(fields: Record<string, string | string[]>, file?: Blob) {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      for (const v of Array.isArray(value) ? value : [value])
        body.append(key, v);
    }
    if (file) body.append("file", file, "cours.pdf");
    return body;
  }

  const post = (body: FormData, auth: string | null = token) =>
    fetch(baseUrl, {
      method: "POST",
      body,
      headers: auth ? { Authorization: `Bearer ${auth}` } : {},
    });

  it("401 sans jeton (utilisateur non authentifié)", async () => {
    const res = await post(form({ text: "x", level: "4e", count: "5" }), null);
    expect(res.status).toBe(401);
    expect(aiService.generate).not.toHaveBeenCalled();
  });

  it("401 avec un jeton invalide", async () => {
    const res = await post(form({ level: "4e", count: "5" }), "faux.jeton.jwt");
    expect(res.status).toBe(401);
    expect(aiService.generate).not.toHaveBeenCalled();
  });

  it("200 : multipart texte, count converti en nombre, types répétés en tableau", async () => {
    const res = await post(
      form({
        text: "Cours",
        level: " 4e ",
        count: "10",
        types: ["single", "true_false"],
      }),
    );
    expect(res.status).toBe(200);
    expect(aiService.generate).toHaveBeenCalledTimes(1);
    const [userId, dto, file] = aiService.generate.mock.calls[0];
    expect(userId).toBe("user-1");
    expect(dto).toMatchObject({
      text: "Cours",
      level: "4e",
      count: 10,
      types: ["single", "true_false"],
    });
    expect(file).toBeUndefined();
  });

  it("accepte types[] et une liste séparée par des virgules", async () => {
    await post(
      form({
        text: "C",
        level: "4e",
        count: "3",
        "types[]": ["ordering", "multiple"],
      }),
    );
    expect(aiService.generate.mock.calls[0][1].types).toEqual([
      "ordering",
      "multiple",
    ]);
    await post(
      form({
        text: "C",
        level: "4e",
        count: "3",
        types: "single,short_answer",
      }),
    );
    expect(aiService.generate.mock.calls[1][1].types).toEqual([
      "single",
      "short_answer",
    ]);
  });

  it("transmet le fichier PDF au service", async () => {
    const pdf = new Blob([Buffer.from("%PDF-1.4\n...")], {
      type: "application/pdf",
    });
    const res = await post(form({ level: "4e", count: "5" }, pdf));
    expect(res.status).toBe(200);
    const file = aiService.generate.mock.calls[0][2];
    expect(file.mimetype).toBe("application/pdf");
    expect(file.buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it.each([
    ["count > 30", { text: "C", level: "4e", count: "31" }],
    ["count = 0", { text: "C", level: "4e", count: "0" }],
    ["count non entier", { text: "C", level: "4e", count: "abc" }],
    ["level absent", { text: "C", count: "5" }],
    ["type poll", { text: "C", level: "4e", count: "5", types: "poll" }],
    ["type inconnu", { text: "C", level: "4e", count: "5", types: "essay" }],
    ["champ inconnu", { text: "C", level: "4e", count: "5", foo: "bar" }],
  ])("400 si %s", async (_label, fields) => {
    const res = await post(form(fields as Record<string, string>));
    expect(res.status).toBe(400);
    expect(aiService.generate).not.toHaveBeenCalled();
  });

  it("413 si le PDF dépasse 10 Mo", async () => {
    const big = new Blob([Buffer.alloc(10 * 1024 * 1024 + 1, 0x20)], {
      type: "application/pdf",
    });
    // Corps multipart sérialisé, envoyé avec http : le serveur peut répondre
    // 413 avant la fin de l'envoi ; seul le code de réponse compte.
    const serialized = new Request(baseUrl, {
      method: "POST",
      body: form({ level: "4e", count: "5" }, big),
    });
    const body = Buffer.from(await serialized.arrayBuffer());
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        baseUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": serialized.headers.get("content-type")!,
            "Content-Length": body.length,
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject); // sans effet si la réponse est déjà arrivée
      req.end(body);
    });
    expect(status).toBe(413);
    expect(aiService.generate).not.toHaveBeenCalled();
  });

  it("GET /quota renvoie l'état du quota de l'utilisateur", async () => {
    const res = await fetch(`${baseUrl}/quota`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(aiService.getQuota).toHaveBeenCalledWith("user-1");
    const unauth = await fetch(`${baseUrl}/quota`);
    expect(unauth.status).toBe(401);
  });
});
