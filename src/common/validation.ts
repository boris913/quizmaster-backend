import type { ValidationPipeOptions } from "@nestjs/common";

/**
 * Options de la `ValidationPipe` globale (main.ts). Partagées avec la
 * génération IA (issue #11), qui valide chaque question générée exactement
 * comme `POST /api/quizzes/:id/questions`.
 */
export const GLOBAL_VALIDATION_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
} as const satisfies ValidationPipeOptions;
