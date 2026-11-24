import { Controller, Get, Req } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Request } from "express";
import type { AddressInfo } from "net";
import { HealthModule } from "./health.module";
import { configureApp } from "../app.setup";

/** Route de test : renvoie l'IP client vue par Express. */
@Controller("test-ip")
class IpController {
  @Get()
  ip(@Req() req: Request) {
    return { ip: req.ip, protocol: req.protocol };
  }
}

/**
 * Issue #27 : sonde `GET /api/health` (publique, sans Supabase) et
 * `trust proxy` derrière Traefik. Vraie application Nest avec la même
 * configuration HTTP que `main.ts` (configureApp).
 */
describe("GET /api/health et trust proxy (issue #27)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    // HealthModule seul : aucun client Supabase ni ConfigService fourni.
    // Si la sonde en dépendait, la compilation du module échouerait.
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
      controllers: [IpController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    configureApp(app);
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("200 sans authentification, avec status ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it("n'est pas servi hors du préfixe /api", async () => {
    const res = await fetch(baseUrl.replace(/\/api$/, "/health"));
    expect(res.status).toBe(404);
  });

  it("trust proxy = 1 : req.ip vient du dernier X-Forwarded-For", async () => {
    expect(app.getHttpAdapter().getInstance().get("trust proxy")).toBe(1);
    const res = await fetch(`${baseUrl}/test-ip`, {
      headers: {
        // Le client a injecté 198.51.100.1, Traefik a ajouté 203.0.113.7
        "X-Forwarded-For": "198.51.100.1, 203.0.113.7",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(await res.json()).toEqual({ ip: "203.0.113.7", protocol: "https" });
  });

  it("sans en-tête de proxy, req.ip est l'adresse de la connexion", async () => {
    const res = await fetch(`${baseUrl}/test-ip`);
    const body = await res.json();
    expect(body.ip).toMatch(/127\.0\.0\.1$/);
    expect(body.protocol).toBe("http");
  });
});
