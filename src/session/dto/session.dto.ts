import {
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  Matches,
} from "class-validator";
import { NICKNAME_MODES, NicknameMode } from "../../common/utils/nickname.util";

export class CreateSessionDto {
  @IsString()
  quiz_id: string;

  /**
   * "free" (défaut) : pseudo libre, filtré côté serveur.
   * "generated" : pseudo choisi parmi les propositions du serveur.
   */
  @IsOptional()
  @IsIn(NICKNAME_MODES, {
    message: "nicknameMode doit valoir 'free' ou 'generated'",
  })
  nicknameMode?: NicknameMode;
}

export class JoinSessionDto {
  @IsString()
  @MinLength(6)
  @MaxLength(6)
  password: string;

  @IsString()
  @MinLength(3, { message: "Le pseudo doit faire au moins 3 caractères" })
  @MaxLength(50, { message: "Le pseudo ne peut pas dépasser 50 caractères" })
  // Lettres (accents compris), chiffres, tirets, underscores et espaces
  // simples entre les mots (pseudos générés : « Loutre Curieuse »).
  @Matches(/^[\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+)*$/u, {
    message:
      "Le pseudo ne peut contenir que des lettres, chiffres, tirets, underscores et espaces simples",
  })
  pseudo: string;
}

export class NicknameSuggestionsQueryDto {
  /** Code (mot de passe) de la session, tel que saisi pour rejoindre. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  code: string;
}
