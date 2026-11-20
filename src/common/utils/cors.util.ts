/**
 * Configuration CORS partagée par l'API HTTP (main.ts) et le gateway Socket.io.
 *
 * Origines autorisées, par ordre de priorité :
 *   1. `CORS_ORIGINS` : liste séparée par des virgules
 *      (ex. `https://kwizora.example.fr,https://www.kwizora.example.fr`) ;
 *   2. `FRONTEND_URL` : ancienne variable, conservée pour compatibilité ;
 *   3. à défaut (développement local) : `http://localhost:3000`.
 *
 * Les variables sont lues à chaque requête et non à l'import : le décorateur
 * `@WebSocketGateway` est évalué avant que `ConfigModule` ne charge `.env`.
 */
export const DEFAULT_DEV_ORIGIN = "http://localhost:3000";

type CorsCallback = (err: Error | null, allow?: boolean) => void;

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

/** Liste des origines autorisées, d'après l'environnement. */
export function getAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.CORS_ORIGINS?.trim() || env.FRONTEND_URL?.trim() || "";
  const origins = raw
    .split(",")
    .map(normalizeOrigin)
    // "*" est refusé : incompatible avec `credentials: true`
    .filter((o) => o.length > 0 && o !== "*");

  return origins.length > 0 ? origins : [DEFAULT_DEV_ORIGIN];
}

/** Vrai si aucune origine n'est configurée explicitement (repli de dev). */
export function isUsingDefaultOrigins(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !env.CORS_ORIGINS?.trim() && !env.FRONTEND_URL?.trim();
}

/**
 * Vrai si l'origine est autorisée. Une requête sans en-tête `Origin`
 * (curl, appel serveur à serveur) n'est pas une requête CORS : elle passe.
 */
export function isOriginAllowed(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!origin) return true;
  return getAllowedOrigins(env).includes(normalizeOrigin(origin));
}

/** Fonction `origin` au format attendu par `cors` (Express et Socket.io). */
export function corsOriginCallback(
  origin: string | undefined,
  callback: CorsCallback,
): void {
  callback(null, isOriginAllowed(origin));
}
