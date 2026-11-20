import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  Matches,
} from "class-validator";
import { Transform } from "class-transformer";
import {
  normalizeSessionCode,
  SCORING_MODES,
  ScoringMode,
} from "../../common/utils/scoring.util";
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

  /**
   * Mode de score (issue #8) :
   * "speed" (défaut) : points dégressifs avec le temps de réponse.
   * "accuracy" : toute bonne réponse dans le temps vaut les points max.
   */
  @IsOptional()
  @IsIn(SCORING_MODES, {
    message: "scoringMode doit valoir 'speed' ou 'accuracy'",
  })
  scoringMode?: ScoringMode;

  /**
   * Classement visible par les joueurs (issue #8), `true` par défaut.
   * À `false`, aucun classement ni rang n'est envoyé aux joueurs.
   */
  @IsOptional()
  @IsBoolean({ message: "showLeaderboard doit être un booléen" })
  showLeaderboard?: boolean;
}

export class JoinSessionDto {
  // Normalisé avant la validation de longueur : " ab c12d " devient "ABC12D"
  @Transform(({ value }) =>
    typeof value === "string" ? normalizeSessionCode(value) : value,
  )
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
