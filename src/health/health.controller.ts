import { Controller, Get, Header } from "@nestjs/common";
import { Public } from "../common/decorators/public.decorator";

/**
 * Sonde de vie (issue #27) : `GET /api/health`.
 *
 * Utilisée par le `HEALTHCHECK` Docker et par Coolify. Volontairement
 * légère : publique, sans garde JWT et sans appel à Supabase, pour qu'une
 * panne de la base ne fasse pas redémarrer le conteneur en boucle.
 */
@Controller("health")
export class HealthController {
  @Public()
  @Get()
  @Header("Cache-Control", "no-store")
  check(): { status: "ok"; uptime: number; timestamp: string } {
    return {
      status: "ok",
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
