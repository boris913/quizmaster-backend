import {
  ArrayMaxSize,
  IsArray,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import {
  PSEUDO_PATTERN,
  PSEUDO_PATTERN_MESSAGE,
} from "../../session/dto/session.dto";

/** POST /api/assignments/:code/start */
export class StartAssignmentDto {
  @IsString()
  @MinLength(3, { message: "Le pseudo doit faire au moins 3 caractères" })
  @MaxLength(50, { message: "Le pseudo ne peut pas dépasser 50 caractères" })
  @Matches(PSEUDO_PATTERN, { message: PSEUDO_PATTERN_MESSAGE })
  pseudo: string;
}

/**
 * POST /api/assignments/:code/answer
 * Aucun temps ni score n'est accepté : ils sont calculés par le serveur
 * (un champ inconnu est refusé par le ValidationPipe global).
 */
export class SubmitAssignmentAnswerDto {
  @IsUUID("all", { message: "questionId doit être un identifiant valide" })
  questionId: string;

  @IsArray({ message: "answers doit être un tableau" })
  @ArrayMaxSize(20, { message: "answers contient trop d'éléments" })
  @IsString({ each: true, message: "answers ne contient que du texte" })
  @MaxLength(500, {
    each: true,
    message: "Une réponse ne peut pas dépasser 500 caractères",
  })
  answers: string[];
}
