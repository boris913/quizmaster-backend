import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleGenAI } from "@google/genai";
import {
  geminiClientProvider,
  resolveAiTimeoutMs,
} from "./gemini-client.provider";

function build(env: Record<string, string | undefined>) {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const factory = (geminiClientProvider as any).useFactory as (
    c: ConfigService,
  ) => GoogleGenAI | null;
  return factory(config);
}

describe("geminiClientProvider", () => {
  afterEach(() => jest.restoreAllMocks());

  it("renvoie null (endpoint 503) si GEMINI_API_KEY est absente ou vide", () => {
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    expect(build({})).toBeNull();
    expect(build({ GEMINI_API_KEY: "   " })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("construit un client Gemini si la clé est définie, sans la journaliser", () => {
    const logs = [
      jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined),
    ];
    const client = build({
      GEMINI_API_KEY: "AIzaSy-test",
      AI_TIMEOUT_MS: "5000",
    });
    expect(client).toBeInstanceOf(GoogleGenAI);
    for (const spy of logs) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("AIzaSy");
      }
    }
  });

  it("AI_TIMEOUT_MS : entier > 0, sinon 120 000 ms", () => {
    expect(resolveAiTimeoutMs("5000")).toBe(5000);
    expect(resolveAiTimeoutMs(undefined)).toBe(120_000);
    expect(resolveAiTimeoutMs("0")).toBe(120_000);
    expect(resolveAiTimeoutMs("abc")).toBe(120_000);
  });
});
