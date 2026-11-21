import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_CLIENT } from "../database/database.module";
import { DEFAULT_AI_MONTHLY_QUOTA } from "./ai.constants";

export interface AiQuotaStatus {
  /** Générations autorisées par mois (AI_MONTHLY_QUOTA). */
  limit: number;
  /** Générations consommées ce mois-ci. */
  used: number;
  remaining: number;
  /** Début du mois suivant (UTC, ISO 8601) : remise à zéro du compteur. */
  resets_at: string;
}

/** Début du mois civil (UTC) contenant `now`, et début du mois suivant. */
export function monthWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  return { start, end };
}

/**
 * Quota mensuel de générations IA par utilisateur (table `ai_generations`,
 * migration 008). Une génération réserve une ligne avant l'appel au
 * fournisseur ; la ligne est supprimée si la génération échoue.
 */
@Injectable()
export class AiQuotaService {
  private readonly logger = new Logger(AiQuotaService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
  ) {}

  /** AI_MONTHLY_QUOTA (entier ≥ 0), 3 par défaut. */
  get limit(): number {
    const raw = this.config.get<string>("AI_MONTHLY_QUOTA");
    if (raw === undefined || raw === null || `${raw}`.trim() === "") {
      return DEFAULT_AI_MONTHLY_QUOTA;
    }
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0
      ? value
      : DEFAULT_AI_MONTHLY_QUOTA;
  }

  private async countThisMonth(userId: string, now: Date): Promise<number> {
    const { start } = monthWindow(now);
    const { count, error } = await this.supabase
      .from("ai_generations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", start.toISOString());
    if (error) {
      this.logger.error(`Lecture du quota IA impossible : ${error.message}`);
      throw new InternalServerErrorException("Lecture du quota impossible");
    }
    return count ?? 0;
  }

  async getStatus(userId: string, now = new Date()): Promise<AiQuotaStatus> {
    const used = await this.countThisMonth(userId, now);
    return this.status(used, now);
  }

  private status(used: number, now: Date): AiQuotaStatus {
    const limit = this.limit;
    return {
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resets_at: monthWindow(now).end.toISOString(),
    };
  }

  private quotaExceeded(status: AiQuotaStatus): HttpException {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: "Too Many Requests",
        message: `Quota de générations IA atteint (${status.limit} par mois). Prochaine remise à zéro : ${status.resets_at}.`,
        quota: status,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** 429 si le quota du mois est déjà atteint (contrôle préalable, sans réserver). */
  async assertAvailable(userId: string, now = new Date()): Promise<void> {
    const status = await this.getStatus(userId, now);
    if (status.remaining <= 0) throw this.quotaExceeded(status);
  }

  /**
   * Réserve une génération : insère une ligne puis recompte. Si le quota est
   * dépassé (requêtes concurrentes), la ligne est retirée et 429 est levée.
   * Renvoie l'id de la réservation et l'état du quota après réservation.
   */
  async reserve(
    userId: string,
    now = new Date(),
  ): Promise<{ id: string; status: AiQuotaStatus }> {
    const { data, error } = await this.supabase
      .from("ai_generations")
      .insert({ user_id: userId })
      .select("id")
      .single();
    if (error || !data) {
      this.logger.error(
        `Réservation du quota IA impossible : ${error?.message ?? "aucune ligne"}`,
      );
      throw new InternalServerErrorException("Réservation du quota impossible");
    }
    const id = (data as { id: string }).id;
    const used = await this.countThisMonth(userId, now).catch(async (e) => {
      await this.release(id);
      throw e;
    });
    const status = this.status(used, now);
    if (used > status.limit) {
      await this.release(id);
      throw this.quotaExceeded(this.status(used - 1, now));
    }
    return { id, status };
  }

  /** Confirme une réservation (nombre de questions renvoyées). */
  async confirm(id: string, questionCount: number): Promise<void> {
    const { error } = await this.supabase
      .from("ai_generations")
      .update({ question_count: questionCount })
      .eq("id", id);
    if (error) {
      // Le quota reste consommé (la ligne existe) : simple journalisation.
      this.logger.warn(
        `Mise à jour de la génération IA ${id} : ${error.message}`,
      );
    }
  }

  /** Annule une réservation (génération échouée : quota non consommé). */
  async release(id: string): Promise<void> {
    const { error } = await this.supabase
      .from("ai_generations")
      .delete()
      .eq("id", id);
    if (error) {
      this.logger.error(
        `Annulation de la réservation IA ${id} impossible : ${error.message}`,
      );
    }
  }
}
