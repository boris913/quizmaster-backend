import { plainToInstance } from "class-transformer";
import { validate, ValidationError } from "class-validator";
import { CreateQuestionDto } from "../quiz/dto/quiz.dto";
import { GLOBAL_VALIDATION_OPTIONS } from "../common/validation";
import {
  GENERATED_QUESTION_MAX_POINTS,
  GENERATED_QUESTION_TIMER_SECONDS,
  GeneratableQuestionType,
} from "./ai.constants";

/** Sortie du modèle illisible (JSON invalide ou forme inattendue). */
export class MalformedAiOutputError extends Error {}

export interface ValidatedQuestions {
  /** Questions valides, au format de `POST /api/quizzes/:id/questions`. */
  questions: CreateQuestionDto[];
  /** Nombre de questions renvoyées par le modèle. */
  generated: number;
  /** Questions écartées (invalides, type non demandé, doublons, surplus). */
  rejected: number;
}

function flattenErrors(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => [
    ...Object.values(e.constraints ?? {}),
    ...flattenErrors(e.children ?? []),
  ]);
}

/**
 * Valide une question générée avec le DTO et les options de la
 * `ValidationPipe` globale, comme le ferait `POST /api/quizzes/:id/questions`.
 * Renvoie la question validée, ou la liste des erreurs.
 */
export async function validateGeneratedQuestion(
  raw: Record<string, unknown>,
): Promise<{ question?: CreateQuestionDto; errors: string[] }> {
  const candidate = {
    max_points: GENERATED_QUESTION_MAX_POINTS,
    timer_seconds: GENERATED_QUESTION_TIMER_SECONDS,
    ...raw,
  };
  const instance = plainToInstance(CreateQuestionDto, candidate);
  const errors = await validate(instance, {
    whitelist: GLOBAL_VALIDATION_OPTIONS.whitelist,
    forbidNonWhitelisted: GLOBAL_VALIDATION_OPTIONS.forbidNonWhitelisted,
  });
  if (errors.length > 0) return { errors: flattenErrors(errors) };
  return { question: candidate as CreateQuestionDto, errors: [] };
}

/**
 * Lit la sortie JSON du modèle et filtre les questions : seules les
 * questions qui passent la validation de `CreateQuestionDto`, d'un type
 * demandé et non dupliquées sont gardées, dans la limite de `count`.
 *
 * @throws MalformedAiOutputError si le JSON est invalide ou n'a pas la forme
 *   `{ questions: [...] }`.
 */
export async function parseAndValidateQuestions(
  rawText: string,
  allowedTypes: readonly GeneratableQuestionType[],
  count: number,
): Promise<ValidatedQuestions> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new MalformedAiOutputError("JSON invalide");
  }
  const list = (parsed as { questions?: unknown })?.questions;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(list)) {
    throw new MalformedAiOutputError("champ questions absent");
  }

  const questions: CreateQuestionDto[] = [];
  const seen = new Set<string>();
  let rejected = 0;

  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      rejected++;
      continue;
    }
    const raw = item as Record<string, unknown>;
    if (!allowedTypes.includes(raw.type as GeneratableQuestionType)) {
      rejected++;
      continue;
    }
    const { question } = await validateGeneratedQuestion(raw);
    const key =
      typeof raw.text === "string" ? raw.text.trim().toLowerCase() : "";
    if (!question || seen.has(key) || questions.length >= count) {
      rejected++;
      continue;
    }
    seen.add(key);
    questions.push(question);
  }

  return { questions, generated: list.length, rejected };
}
