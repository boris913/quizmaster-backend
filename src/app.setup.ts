import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { GLOBAL_VALIDATION_OPTIONS } from "./common/validation";
import { corsOriginCallback } from "./common/utils/cors.util";

/**
 * Configuration HTTP commune à `main.ts` et aux tests d'intégration.
 */
export function configureApp(app: NestExpressApplication): void {
  // Derrière Traefik (Coolify) : un seul proxy de confiance devant l'app.
  // req.ip et req.protocol sont alors lus dans X-Forwarded-For / -Proto
  // (IP réelle du client dans les logs et pour une éventuelle limitation
  // de débit). « 1 » et non « true » : un client ne peut pas usurper son IP
  // en ajoutant lui-même un X-Forwarded-For.
  app.set("trust proxy", 1);

  // CORS : origines autorisées via CORS_ORIGINS (voir common/utils/cors.util.ts)
  app.enableCors({
    origin: corsOriginCallback,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // X-Resume-Token : jeton de reprise des devoirs (issue #10)
    allowedHeaders: ["Content-Type", "Authorization", "X-Resume-Token"],
  });

  // Validation globale des DTOs
  app.useGlobalPipes(new ValidationPipe(GLOBAL_VALIDATION_OPTIONS));

  // Prefix global API (Socket.io garde son chemin /socket.io, même port)
  app.setGlobalPrefix("api");
}
