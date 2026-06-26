import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsArray,
  IsEnum,
  IsIn,
  ValidateNested,
  MinLength,
  MaxLength,
  Min,
  Max,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class QuizOptionDto {
  @IsString()
  @IsIn(['A', 'B', 'C', 'D'])
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

  @IsEnum(['single', 'multiple'])
  type: 'single' | 'multiple';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuizOptionDto)
  @ArrayMinSize(2)
  options: QuizOptionDto[];

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  correct_answers: string[];

  @IsNumber()
  @Min(10)
  @Max(1000)
  max_points: number;

  @IsOptional()
  @IsNumber()
  @Min(5)
  @Max(300)
  timer_seconds?: number;
}

export class CreateQuizDto {
  @IsString()
  @MinLength(3, { message: 'Le titre doit faire au moins 3 caractères' })
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

export class ImportQuestionsDto {
  @IsString()
  questions_content: string;

  @IsOptional()
  @IsString()
  answers_content?: string;
}
