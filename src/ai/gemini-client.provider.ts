import { Logger, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleGenAI } from "@google/genai";
import { DEFAULT_AI_TIMEOUT_MS, GEMINI_CLIENT } from "./ai.constants";

/** AI_TIMEOUT_MS (entier > 0, en ms), 120 000 par défaut. */
export function resolveAiTimeoutMs(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_AI_TIMEOUT_MS;
}

/**
 * Client Google Gemini (SDK officiel `@google/genai`), construit uniquement si
 * GEMINI_API_KEY est définie. Sinon `null` : l'application démarre normalement
 * et `POST /api/quizzes/generate` répond 503. La clé n'est jamais journalisée.
 *
 * Délai d'attente : `httpOptions.timeout` (AI_TIMEOUT_MS), appliqué par le SDK.
 * Aucune nouvelle tentative automatique (`retryOptions` absent) : sur le free
 * tier, réessayer un 429 consommerait la limite de débit pour rien.
 */
export const geminiClientProvider: Provider = {
  provide: GEMINI_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): GoogleGenAI | null => {
    const apiKey = config.get<string>("GEMINI_API_KEY")?.trim();
    if (!apiKey) {
      new Logger("AiModule").warn(
        "GEMINI_API_KEY non définie : la génération de quiz par IA est désactivée (503).",
      );
      return null;
    }
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: resolveAiTimeoutMs(config.get<string>("AI_TIMEOUT_MS")),
      },
    });
  },
};
