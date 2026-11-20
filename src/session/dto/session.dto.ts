import {
  IsBoolean,
  IsIn,
  IsISO8601,
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
import {
  SESSION_MODES,
  SessionMode,
  SHOW_EXPLANATIONS_MODES,
  ShowExplanationsMode,
} from "../../assignment/assignment.util";

/**
 * Règles de validation d'un pseudo (partagées par `POST /sessions/join` et
 * `POST /assignments/:code/start`).
 */
export const PSEUDO_PATTERN = /^[\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+)*$/u;
export const PSEUDO_PATTERN_MESSAGE =
  "Le pseudo ne peut contenir que des lettres, chiffres, tirets, underscores et espaces simples";

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

  /**
   * Mode de la session (issue #10) : "live" (défaut, partie pilotée en
   * direct) ou "async" (devoir, chaque élève avance seul jusqu'à `dueAt`).
   */
  @IsOptional()
  @IsIn(SESSION_MODES, { message: "mode doit valoir 'live' ou 'async'" })
  mode?: SessionMode;

  /**
   * Échéance du devoir (ISO 8601 avec fuseau, ex. "2026-12-01T18:00:00Z").
   * Obligatoire en mode "async", interdite en mode "live". Doit être dans le
   * futur et à 365 jours au plus.
   */
  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: "dueAt doit être une date ISO 8601 (ex. 2026-12-01T18:00:00Z)" },
  )
  dueAt?: string;

  /**
   * Devoir uniquement (issue #10) : "each" (défaut) révèle le verdict et
   * l'explication après chaque réponse, "end" à la fin du devoir de l'élève.
   */
  @IsOptional()
  @IsIn(SHOW_EXPLANATIONS_MODES, {
    message: "showExplanations doit valoir 'each' ou 'end'",
  })
  showExplanations?: ShowExplanationsMode;
}

/**
 * PATCH /api/sessions/:id (devoir uniquement, issue #10) : prolonger
 * l'échéance (`dueAt`) ou clore le devoir (`status: "finished"`), l'un ou
 * l'autre.
 */
export class UpdateSessionDto {
  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: "dueAt doit être une date ISO 8601 (ex. 2026-12-01T18:00:00Z)" },
  )
  dueAt?: string;

  @IsOptional()
  @IsIn(["finished"], { message: "status ne peut valoir que 'finished'" })
  status?: "finished";
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
  @Matches(PSEUDO_PATTERN, { message: PSEUDO_PATTERN_MESSAGE })
  pseudo: string;
}

export class NicknameSuggestionsQueryDto {
  /** Code (mot de passe) de la session, tel que saisi pour rejoindre. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  code: string;
}
