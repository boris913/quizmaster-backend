import { IsString, MinLength, MaxLength, Matches } from "class-validator";

export class RegisterDto {
  @IsString()
  @MinLength(3, { message: "Le pseudo doit faire au moins 3 caractères" })
  @MaxLength(50, { message: "Le pseudo ne peut pas dépasser 50 caractères" })
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message:
      "Le pseudo ne peut contenir que des lettres, chiffres, tirets et underscores",
  })
  pseudo: string;

  @IsString()
  @MinLength(6, { message: "Le mot de passe doit faire au moins 6 caractères" })
  @MaxLength(100)
  password: string;
}

export class LoginDto {
  @IsString()
  pseudo: string;

  @IsString()
  password: string;
}
