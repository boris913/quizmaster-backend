import { Logger, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  AI_MAX_RETRIES,
  ANTHROPIC_CLIENT,
  DEFAULT_AI_TIMEOUT_MS,
} from "./ai.constants";

/** AI_TIMEOUT_MS (entier > 0, en ms), 120 000 par défaut. */
export function resolveAiTimeoutMs(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_AI_TIMEOUT_MS;
}

/**
 * Client Anthropic, construit uniquement si ANTHROPIC_API_KEY est définie.
 * Sinon `null` : l'application démarre normalement et
 * `POST /api/quizzes/generate` répond 503. La clé n'est jamais journalisée.
 */
export const anthropicClientProvider: Provider = {
  provide: ANTHROPIC_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Anthropic | null => {
    const apiKey = config.get<string>("ANTHROPIC_API_KEY")?.trim();
    if (!apiKey) {
      new Logger("AiModule").warn(
        "ANTHROPIC_API_KEY non définie : la génération de quiz par IA est désactivée (503).",
      );
      return null;
    }
    return new Anthropic({
      apiKey,
      timeout: resolveAiTimeoutMs(config.get<string>("AI_TIMEOUT_MS")),
      maxRetries: AI_MAX_RETRIES,
    });
  },
};
