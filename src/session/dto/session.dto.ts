import { IsString, MinLength, MaxLength, Matches } from "class-validator";

export class CreateSessionDto {
  @IsString()
  quiz_id: string;
}

export class JoinSessionDto {
  @IsString()
  @MinLength(6)
  @MaxLength(6)
  password: string;

  @IsString()
  @MinLength(3, { message: "Le pseudo doit faire au moins 3 caractères" })
  @MaxLength(50, { message: "Le pseudo ne peut pas dépasser 50 caractères" })
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message:
      "Le pseudo ne peut contenir que des lettres, chiffres, tirets et underscores",
  })
  pseudo: string;
}
