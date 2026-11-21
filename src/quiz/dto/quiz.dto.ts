import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsArray,
  IsIn,
  IsInt,
  Matches,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  ArrayMaxSize,
  ValidateNested,
  MinLength,
  MaxLength,
  Min,
  Max,
  ArrayMinSize,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import {
  ALL_OPTION_IDS,
  QUESTION_TYPES,
  QuestionType,
  SHORT_ANSWER_MAX_VARIANTS,
  SHORT_ANSWER_VARIANT_MAX_LENGTH,
  validateQuestionByType,
} from "../../common/utils/question-types.util";
import { IMPORT_FORMATS, ImportFormat } from "../importers/import.types";

/** Types MIME acceptés pour une image de question (issue #7). */
export const QUESTION_IMAGE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type QuestionImageContentType =
  (typeof QUESTION_IMAGE_CONTENT_TYPES)[number];

/** Taille maximale d'une image de question : 2 Mo. */
export const QUESTION_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Longueur maximale de `questions.image_url` (DTO et contrainte SQL, migration 005). */
export const IMAGE_URL_MAX_LENGTH = 2048;

/**
 * Règles par type de question (issue #7), appliquées à l'objet entier :
 * nombre et ids d'options, forme de `correct_answers`. Voir
 * `validateQuestionByType`.
 */
@ValidatorConstraint({ name: "questionTypeRules", async: false })
export class QuestionTypeRulesConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return (
      validateQuestionByType(args.object as CreateQuestionDto).length === 0
    );
  }

  defaultMessage(args: ValidationArguments): string {
    return validateQuestionByType(args.object as CreateQuestionDto).join(" ; ");
  }
}

export class QuizOptionDto {
  /**
   * 'A'…'D' (single/multiple), 'A'…'F' (ordering/poll), 'true'/'false'
   * (true_false). Le détail par type est vérifié par `questionTypeRules`.
   */
  @IsString()
  @IsIn(ALL_OPTION_IDS)
  id: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  text: string;
}

export class CreateQuestionDto {
  @IsString()
  @MinLength(1, { message: "L'énoncé ne peut pas être vide" })
  @MaxLength(1000)
  text: string;

  /** Type de question (issue #7). Règles par type : `questionTypeRules`. */
  @IsIn(QUESTION_TYPES)
  @Validate(QuestionTypeRulesConstraint)
  type: QuestionType;

  /**
   * single/multiple : 2 à 4 options A-D ; true_false : absent, `[]` ou les
   * 2 options `true`/`false` ; ordering : 3 à 6 options A-F ; poll : 2 à 6
   * options A-F ; short_answer : absent ou `[]`.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuizOptionDto)
  @ArrayMaxSize(6)
  options?: QuizOptionDto[];

  /**
   * single : 1 id ; multiple : ≥ 1 id ; true_false : ["true"] ou ["false"] ;
   * ordering : tous les ids dans l'ordre attendu ; short_answer : 1 à 20
   * variantes acceptées ; poll : absent ou `[]`.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(SHORT_ANSWER_VARIANT_MAX_LENGTH, { each: true })
  @ArrayMaxSize(SHORT_ANSWER_MAX_VARIANTS)
  correct_answers?: string[];

  @IsNumber()
  @Min(10)
  @Max(1000)
  max_points: number;

  @IsOptional()
  @IsNumber()
  @Min(5)
  @Max(300)
  timer_seconds?: number;

  /**
   * Explication de la bonne réponse (issue #6). Envoyée aux joueurs
   * uniquement à la clôture de la question ("question:reveal").
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  explanation?: string;

  /**
   * URL de l'image (issue #7), en général la `public_url` renvoyée par
   * `POST /api/quizzes/:id/questions/image-upload-url`. http(s) uniquement.
   */
  @IsOptional()
  @IsString()
  @MaxLength(IMAGE_URL_MAX_LENGTH)
  @Matches(/^https?:\/\/\S+$/i, {
    message: "image_url doit être une URL http(s)",
  })
  image_url?: string | null;
}

/** Corps de `POST /api/quizzes/:id/questions`. */
export class AddQuestionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateQuestionDto)
  questions: CreateQuestionDto[];
}

/** Corps de `POST /api/quizzes/:id/questions/image-upload-url` (issue #7). */
export class ImageUploadUrlDto {
  @IsIn(QUESTION_IMAGE_CONTENT_TYPES, {
    message: `content_type doit valoir ${QUESTION_IMAGE_CONTENT_TYPES.join(", ")}`,
  })
  content_type: QuestionImageContentType;

  /** Taille du fichier en octets (1 à 2 Mo). */
  @IsInt()
  @Min(1)
  @Max(QUESTION_IMAGE_MAX_BYTES, { message: "L'image dépasse 2 Mo" })
  size: number;
}

export class CreateQuizDto {
  @IsString()
  @MinLength(3, { message: "Le titre doit faire au moins 3 caractères" })
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsNumber()
  @Min(5)
  @Max(300)
  global_timer_seconds: number;

  @IsBoolean()
  use_global_timer: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateQuestionDto)
  questions?: CreateQuestionDto[];
}

export class UpdateQuizDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(5)
  @Max(300)
  global_timer_seconds?: number;

  @IsOptional()
  @IsBoolean()
  use_global_timer?: boolean;
}

/**
 * Corps JSON de `POST /api/quizzes/:id/import` (import Markdown). Facultatif
 * avec `?format=...` et un fichier multipart (champ `file`).
 */
export class ImportQuestionsDto {
  @IsOptional()
  @IsString()
  questions_content?: string;

  @IsOptional()
  @IsString()
  answers_content?: string;
}

/**
 * Paramètres de requête de `POST /api/quizzes/:id/import` (issue #12).
 * Sans `format` : import Markdown historique (réponse = questions créées).
 * Avec `format` : réponse `{ imported, errors, ... }` et `dryRun` possible.
 */
export class ImportQueryDto {
  @IsOptional()
  @IsIn(IMPORT_FORMATS, {
    message: `format doit valoir ${IMPORT_FORMATS.join(", ")}`,
  })
  format?: ImportFormat;

  /** `true` / `1` : analyse et validation sans rien enregistrer. */
  @IsOptional()
  @Transform(({ value }) =>
    value === true || value === "true" || value === "1"
      ? true
      : value === false || value === "false" || value === "0"
        ? false
        : value,
  )
  @IsBoolean({ message: "dryRun doit valoir true ou false" })
  dryRun?: boolean;
}
