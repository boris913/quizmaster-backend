import { plainToInstance } from "class-transformer";
import { ValidationError, validate } from "class-validator";
import { CreateQuestionDto } from "./dto/quiz.dto";

/**
 * Options identiques au `ValidationPipe` global (`main.ts`) : une question
 * importée ou copiée est validée exactement comme le corps de
 * `POST /api/quizzes/:id/questions`.
 */
export const QUESTION_VALIDATION_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
} as const;

function collectMessages(errors: ValidationError[], prefix = ""): string[] {
  return errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    const own = Object.values(e.constraints ?? {}).map((m) =>
      m.startsWith(e.property) || m.includes(path) ? m : `${path} : ${m}`,
    );
    return [...own, ...collectMessages(e.children ?? [], path)];
  });
}

/**
 * Valide un objet brut avec `CreateQuestionDto` (class-transformer puis
 * class-validator). Renvoie la question typée ou la liste des erreurs.
 */
export async function validateQuestionPlain(
  plain: Record<string, unknown>,
): Promise<
  { ok: true; question: CreateQuestionDto } | { ok: false; errors: string[] }
> {
  const instance = plainToInstance(CreateQuestionDto, plain);
  const errors = await validate(instance, QUESTION_VALIDATION_OPTIONS);
  if (errors.length > 0) {
    return { ok: false, errors: [...new Set(collectMessages(errors))] };
  }
  return { ok: true, question: instance };
}
