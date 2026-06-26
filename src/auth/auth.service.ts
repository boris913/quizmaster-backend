import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  Inject,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { SupabaseClient } from "@supabase/supabase-js";
import * as bcrypt from "bcryptjs";
import { SUPABASE_CLIENT } from "../database/database.module";
import { RegisterDto, LoginDto } from "./dto/auth.dto";

@Injectable()
export class AuthService {
  constructor(
    @Inject(SUPABASE_CLIENT) private supabase: SupabaseClient,
    private jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    // Vérifie si le pseudo est déjà pris
    const { data: existing } = await this.supabase
      .from("users")
      .select("id")
      .eq("pseudo", dto.pseudo)
      .single();

    if (existing) {
      throw new ConflictException("Ce pseudo est déjà utilisé");
    }

    // Hash du mot de passe
    const passwordHash = await bcrypt.hash(dto.password, 12);

    // Création de l'utilisateur
    const { data: user, error } = await this.supabase
      .from("users")
      .insert({ pseudo: dto.pseudo, password_hash: passwordHash })
      .select("id, pseudo, created_at")
      .single();

    if (error) {
      throw new Error(`Erreur création utilisateur: ${error.message}`);
    }

    const token = this.generateToken(user.id, user.pseudo);

    return {
      user: { id: user.id, pseudo: user.pseudo, created_at: user.created_at },
      access_token: token,
    };
  }

  async login(dto: LoginDto) {
    // Recherche de l'utilisateur
    const { data: user, error } = await this.supabase
      .from("users")
      .select("id, pseudo, password_hash, created_at")
      .eq("pseudo", dto.pseudo)
      .single();

    if (error || !user) {
      throw new UnauthorizedException("Pseudo ou mot de passe incorrect");
    }

    // Vérification du mot de passe
    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user.password_hash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException("Pseudo ou mot de passe incorrect");
    }

    const token = this.generateToken(user.id, user.pseudo);

    return {
      user: { id: user.id, pseudo: user.pseudo, created_at: user.created_at },
      access_token: token,
    };
  }

  async getProfile(userId: string) {
    const { data: user, error } = await this.supabase
      .from("users")
      .select("id, pseudo, created_at")
      .eq("id", userId)
      .single();

    if (error || !user) {
      throw new UnauthorizedException("Utilisateur introuvable");
    }

    return user;
  }

  private generateToken(userId: string, pseudo: string): string {
    return this.jwtService.sign({ sub: userId, pseudo });
  }
}
