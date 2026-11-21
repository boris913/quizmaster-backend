import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import {
  AI_LEVEL_MAX_LENGTH,
  AI_MAX_QUESTIONS,
  AI_MIN_QUESTIONS,
  AI_TEXT_FIELD_MAX_CHARS,
  GENERATABLE_QUESTION_TYPES,
  GeneratableQuestionType,
} from "../ai.constants";

/**
 * `types` arrive en multipart sous plusieurs formes : champ répété
 * (`types=single&types=multiple`), `types[]=…`, ou une seule valeur, éventuellement
 * séparée par des virgules (`types=single,multiple`). Normalisé en tableau.
 */
function toTypesArray({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((v) => (typeof v === "string" ? v.split(",") : [v]))
    .map((v) => (typeof v === "string" ? v.trim() : v))
    .filter((v) => v !== "");
}

/**
 * Corps de `POST /api/quizzes/generate` (multipart/form-data ; le fichier
 * PDF éventuel est le champ `file`, hors DTO).
 */
export class GenerateQuizDto {
  /** Texte du cours. Exclusif avec `file` : fournir l'un ou l'autre. */
  @IsOptional()
  @IsString()
  @MaxLength(AI_TEXT_FIELD_MAX_CHARS, {
    message: `text ne doit pas dépasser ${AI_TEXT_FIELD_MAX_CHARS} caractères`,
  })
  text?: string;

  /** Niveau de la classe, ex. « 4e », « Terminale », « BTS 1re année ». */
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: "level est obligatoire (ex. « 4e »)" })
  @MaxLength(AI_LEVEL_MAX_LENGTH)
  level: string;

  /** Nombre de questions souhaité (1 à 30). */
  @Type(() => Number)
  @IsInt({ message: "count doit être un entier" })
  @Min(AI_MIN_QUESTIONS)
  @Max(AI_MAX_QUESTIONS)
  count: number;

  /**
   * Types de question souhaités (défaut : single, multiple, true_false).
   * `poll` n'est pas générable.
   */
  @IsOptional()
  @Transform(toTypesArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(GENERATABLE_QUESTION_TYPES.length)
  @IsIn(GENERATABLE_QUESTION_TYPES, {
    each: true,
    message: `types : valeurs possibles ${GENERATABLE_QUESTION_TYPES.join(", ")} (poll n'est pas générable)`,
  })
  types?: GeneratableQuestionType[];
}
