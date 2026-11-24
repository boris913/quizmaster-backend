# Déploiement sur un VPS Coolify

Guide du mainteneur pour déployer Kwizora sur un VPS géré par **Coolify 4.x**
(reverse proxy **Traefik v3**, HTTPS automatique Let's Encrypt).

> Ce document ne contient **aucune** valeur réelle. Les éléments entre chevrons
> (`<IP_DU_VPS>`, `<CLE_SERVICE_ROLE>`…) sont à remplacer au moment de la
> saisie, jamais dans un fichier commité.

## 1. Architecture cible

```
Internet ──HTTPS──> Traefik (Coolify)
                      ├─ https://kwizora.com           -> frontend Next.js
                      ├─ https://api.kwizora.com       -> backend (conteneur, port 3001)
                      │                                    API REST /api/* + Socket.io /socket.io/*
                      └─ https://supabase.kwizora.com  -> Kong (Supabase auto-hébergé)
                                                           REST, Storage, Studio (protégé)
```

- Le backend parle à Supabase **par son URL publique**
  (`SUPABASE_URL=https://supabase.kwizora.com`) avec la clé `service_role`.
  C'est nécessaire : les URL signées d'upload d'images et les URL publiques du
  bucket `question-images` sont construites à partir de cette URL et ouvertes
  par le navigateur des utilisateurs.
- HTTP et WebSocket (Socket.io) partagent **le même port (3001)** et le même
  domaine. Traefik v3 gère l'upgrade WebSocket sans configuration.
- **Une seule instance du backend** : l'état des parties en direct (salles
  Socket.io, minuteurs) est en mémoire. Ne pas augmenter le nombre de
  réplicas sans ajouter un adaptateur Socket.io partagé (Redis) et des
  sessions collantes.

## 2. Prérequis

1. Coolify installé sur le VPS, serveur « localhost » validé, proxy Traefik
   démarré.
2. Enregistrements DNS de type `A` (et `AAAA` si IPv6) pointant vers
   `<IP_DU_VPS>` :
   - `kwizora.com` (frontend) ;
   - `api.kwizora.com` (backend) ;
   - `supabase.kwizora.com` (Supabase).
3. Pare-feu du VPS : seuls `22` (SSH, idéalement restreint), `80` et `443`
   ouverts. **Pas** de port PostgreSQL (`5432`, `6543`) ni de port Coolify
   (`8000`) exposé publiquement si l'interface Coolify a son propre domaine.

## 3. Service Supabase dans Coolify

### 3.1 Création

1. **Projects → (projet) → + New → Service → Supabase.**
2. Dans la configuration du service, sur le sous-service **Supabase Kong**,
   renseigner le domaine `https://supabase.kwizora.com`. C'est le seul
   sous-service qui doit avoir un domaine : ne pas en attribuer à Studio,
   à PostgreSQL, à Meta, etc.
3. Onglet **Environment Variables** : Coolify génère les secrets du modèle.
   Relever (sans les copier ailleurs que dans Coolify) :

   | Rôle | Variable du modèle Coolify (à vérifier dans l'onglet) |
   |---|---|
   | Clé `service_role` (pour le backend) | `SERVICE_SUPABASESERVICE_KEY` |
   | Clé `anon` (non utilisée par le backend) | `SERVICE_SUPABASEANON_KEY` |
   | Mot de passe PostgreSQL | `SERVICE_PASSWORD_POSTGRES` |
   | Identifiants du tableau de bord (Studio) | `SERVICE_USER_ADMIN` / `SERVICE_PASSWORD_ADMIN` |
   | URL publique de l'API | `SERVICE_FQDN_SUPABASEKONG` (= `https://supabase.kwizora.com`) |

   Vérifier que `API_EXTERNAL_URL` et `SUPABASE_PUBLIC_URL` valent bien
   `https://supabase.kwizora.com` (en `https`, sans `/` final). Sinon les URL
   de Storage renvoyées au navigateur seront fausses.
4. **Ne pas** cocher « Make it publicly available » sur la base PostgreSQL.
5. **Deploy**, puis attendre que tous les conteneurs soient `healthy`
   (le conteneur Storage crée le schéma `storage` à son premier démarrage :
   il doit être démarré avant de créer le bucket, voir § 5.4).

### 3.2 Accès à l'administration sans exposer Studio

Dans le modèle Coolify, Kong sert Studio à la racine de
`https://supabase.kwizora.com`, derrière une **authentification basique**
(identifiants `SERVICE_USER_ADMIN` / `SERVICE_PASSWORD_ADMIN`). C'est l'« URL
protégée » de Coolify. Règles :

- garder le mot de passe généré par Coolify (long, aléatoire, jamais réutilisé) ;
- ne jamais partager ces identifiants ni les mettre dans le frontend.

Pour l'administration courante, préférer l'une de ces deux voies, qui ne
passent pas par Internet :

**a) `psql` par SSH (recommandé pour l'initialisation et les migrations)**

```bash
ssh <UTILISATEUR>@<IP_DU_VPS>
# Nom du conteneur PostgreSQL du service Supabase
docker ps --format '{{.Names}}' | grep -i supabase-db
```

Puis les commandes du § 5.

**b) Studio par tunnel SSH**

Studio écoute sur le port `3000` dans le réseau Docker du service, sans port
publié sur l'hôte. On le joint par un tunnel vers l'IP interne du conteneur :

```bash
# Sur le VPS : IP interne du conteneur Studio
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' \
  $(docker ps --format '{{.Names}}' | grep -i supabase-studio)

# Sur votre poste
ssh -N -L 3000:<IP_INTERNE_STUDIO>:3000 <UTILISATEUR>@<IP_DU_VPS>
# puis ouvrir http://localhost:3000
```

Pour fermer complètement l'accès public à Studio, on peut retirer la route
`dashboard` du fichier `kong.yml` du service (onglet **Persistent Storage /
Storages** du service dans Coolify), puis redémarrer Kong. **À vérifier**
après chaque mise à jour du modèle Coolify, qui peut réécrire ce fichier.
Les routes `/rest/v1`, `/storage/v1`, etc. doivent rester en place : le
backend et les navigateurs en ont besoin.

## 4. Application backend dans Coolify

1. **+ New → Application → Public Repository** (le dépôt est public) ou
   **Private Repository (GitHub App)** si l'application GitHub de Coolify est
   installée (permet le déploiement automatique au push).
   - Dépôt : `https://github.com/boris913/quizmaster-backend`
   - Branche : `main`
2. **Build Pack : `Dockerfile`** (fichier `Dockerfile` à la racine,
   « Base Directory » `/`).
3. **Ports Exposes : `3001`.**
4. **Domains : `https://api.kwizora.com`.** Traefik route ce domaine vers le
   port exposé et obtient le certificat automatiquement.
5. **Healthcheck** : l'image déclare déjà un `HEALTHCHECK` Docker sur
   `GET /api/health`. Si l'on active aussi le healthcheck Coolify, le régler
   sur : méthode `GET`, chemin `/api/health`, port `3001`, code attendu `200`.
6. Renseigner les variables (§ 6), puis **Deploy**.

Ce que fait l'image (voir `Dockerfile`) : build multi-étapes Node 22 alpine (Node 22 minimum : `@supabase/supabase-js` exige un WebSocket natif),
seules les dépendances de production dans l'image finale, exécution par
l'utilisateur non-root `node`, écoute sur `0.0.0.0:$PORT` (3001 par défaut).
Le backend fait confiance à **un** proxy (`trust proxy = 1`) : l'IP client
(`req.ip`) et le protocole viennent des en-têtes `X-Forwarded-*` ajoutés par
Traefik.

## 5. Initialisation d'une base vide

À faire **une fois**, avant le premier déploiement du backend. Ordre :

1. `supabase-schema.sql` ;
2. `migrations/001_…` à `migrations/008_…`, dans l'ordre des numéros ;
3. bucket public `question-images` ;
4. extension `pg_cron`, puis rejouer `002_retention_purge.sql`.

> `migrations/000_initial_schema.sql` est une copie de `supabase-schema.sql`
> (non idempotente) : exécuter **l'un ou l'autre**, pas les deux.

### 5.1 Copier les scripts sur le VPS

Depuis une copie locale du dépôt (branche `main`) :

```bash
ssh <UTILISATEUR>@<IP_DU_VPS> 'mkdir -p ~/kwizora-sql'
scp supabase-schema.sql migrations/00[1-8]_*.sql <UTILISATEUR>@<IP_DU_VPS>:~/kwizora-sql/
```

### 5.2 Exécuter le schéma et les migrations

Sur le VPS :

```bash
cd ~/kwizora-sql
DB=<NOM_DU_CONTENEUR_SUPABASE_DB>      # cf. docker ps (§ 3.2 a)
read -rs PGPASSWORD; export PGPASSWORD # coller SERVICE_PASSWORD_POSTGRES (non affiché)

run_sql() {
  echo "== $1"
  docker exec -i -e PGPASSWORD "$DB" \
    psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 < "$1"
}

run_sql supabase-schema.sql
for f in 00[1-8]_*.sql; do run_sql "$f" || break; done
unset PGPASSWORD
```

Le glob `00[1-8]_*.sql` est trié par le shell : 001, 002, … 008. En cas
d'erreur, la boucle s'arrête ; les migrations 001 à 008 étant idempotentes,
on peut corriger puis relancer la boucle.

Variante : coller le contenu de chaque fichier, dans le même ordre, dans le
**SQL Editor** de Studio (accès par tunnel, § 3.2 b).

### 5.3 Compatibilité avec l'image `supabase/postgres`

Points vérifiés dans les scripts :

- **`uuid-ossp`** : l'image l'installe déjà dans le schéma `extensions`.
  `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` est alors sans effet, et
  `uuid_generate_v4()` est trouvée car `extensions` fait partie du
  `search_path` par défaut. Contrôle :
  ```sql
  SHOW search_path;                          -- doit contenir extensions
  SELECT extname, extnamespace::regnamespace FROM pg_extension;
  ```
  Si `function uuid_generate_v4() does not exist` apparaît, ajouter
  `SET search_path = public, extensions;` en tête de la session et relancer.
- **Rôles** `service_role`, `anon`, `authenticated` : fournis par l'image ;
  les policies `TO service_role` et les `REVOKE`/`GRANT` de la migration 002
  s'appliquent. Les privilèges par défaut de Supabase donnent à
  `service_role` l'accès aux tables créées par `postgres` dans `public` :
  ```sql
  SELECT has_table_privilege('service_role', 'public.quizzes', 'SELECT,INSERT,UPDATE,DELETE');
  ```
- **Aucun autre schéma ni extension** n'est requis (pas de `pgcrypto`, pas de
  référence à `auth.*` : l'authentification est gérée par le backend).

### 5.4 Bucket `question-images`

Le schéma `storage` est créé par le conteneur Storage au démarrage (vérifier
qu'il est `healthy`). Exécuter le script idempotent documenté dans
[`migrations/README.md`](../migrations/README.md#création-sql-editor-supabase)
(bucket **public**, 2 Mo, `image/png`, `image/jpeg`, `image/webp`,
`image/gif`, **aucune** policy sur `storage.objects`), puis la requête de
contrôle des policies qui y figure.

### 5.5 `pg_cron` (purge RGPD quotidienne)

`pg_cron` est préchargé par l'image ; il suffit de créer l'extension, puis de
rejouer la migration 002 qui planifie la tâche :

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
```

```bash
run_sql 002_retention_purge.sql   # même fonction qu'au § 5.2
```

Contrôle (heure en UTC) :

```sql
SELECT jobname, schedule, command FROM cron.job;
-- attendu : quizmaster-anonymize-participants | 15 3 * * *
```

Alternative : Studio → **Database → Extensions → pg_cron → Enable**, puis
rejouer 002.

### 5.6 Migrations suivantes

Pour toute nouvelle migration `009_…` : l'appliquer avec `run_sql` (ou le SQL
Editor) **avant** de déployer le code qui en dépend (voir
`migrations/README.md`).

## 6. Variables d'environnement du backend

À saisir dans Coolify → application backend → **Environment Variables**.
Ce sont des variables d'exécution : laisser décochée l'option « Build
Variable » (l'image n'en a pas besoin au build) et marquer les secrets comme
tels.

| Variable | Statut | Valeur en production | Remarque |
|---|---|---|---|
| `SUPABASE_URL` | **obligatoire** | `https://supabase.kwizora.com` | sans `/` final ; le backend refuse de démarrer sans |
| `SUPABASE_SERVICE_ROLE_KEY` | **obligatoire**, secret | `<CLE_SERVICE_ROLE>` | valeur de `SERVICE_SUPABASESERVICE_KEY` du service Supabase ; jamais côté frontend |
| `JWT_SECRET` | **obligatoire**, secret | `<SECRET_JWT_BACKEND>` | secret propre au backend (signature des jetons Kwizora, HTTP et WebSocket), **distinct** du secret JWT de Supabase. Générer : `openssl rand -base64 48` |
| `CORS_ORIGINS` | **obligatoire** en production | `https://kwizora.com` | liste séparée par des virgules, sans `/` final (ajouter `https://www.kwizora.com` si utilisé). Sans elle, seul `http://localhost:3000` est autorisé (API et Socket.io) |
| `PORT` | facultatif | `3001` | défaut de l'image et du code ; doit correspondre à « Ports Exposes » |
| `NODE_ENV` | facultatif | `production` | déjà fixé par l'image |
| `JWT_EXPIRES_IN` | facultatif | `7d` | durée de validité des jetons (défaut `7d`) |
| `GEMINI_API_KEY` | facultatif, secret | `<CLE_API_GEMINI>` | génération de quiz par IA ; sans clé, l'application démarre et `POST /api/quizzes/generate` répond 503 |
| `AI_MODEL` | facultatif | vide = modèle par défaut du code | |
| `AI_MONTHLY_QUOTA` | facultatif | vide = défaut du code (3) | générations par enseignant et par mois civil UTC |
| `AI_TIMEOUT_MS` | facultatif | vide = défaut du code (120000) | délai d'un appel IA |
| `FRONTEND_URL` | dépréciée | ne pas définir | lue seulement si `CORS_ORIGINS` est absente |

Notes :

- `GEMINI_API_KEY` : en production pour des utilisateurs de l'EEE, les
  conditions de l'API Gemini imposent un projet Google avec facturation
  activée (pas le free tier). Voir `docs/registre-traitement.md`.
- `SUPABASE_ANON_KEY` figure dans `.env.example` mais n'est lue nulle part par
  le backend : inutile en production.
- Aucun fichier `.env` n'est copié dans l'image (`.dockerignore`) : tout passe
  par les variables Coolify.

## 7. Vérifications après déploiement

1. **Santé** (publique, ne touche pas la base) :
   ```bash
   curl -i https://api.kwizora.com/api/health
   # HTTP/2 200 … {"status":"ok","uptime":…,"timestamp":"…"}
   ```
   Statut Docker sur le VPS :
   `docker inspect -f '{{.State.Health.Status}}' <NOM_DU_CONTENEUR_BACKEND>`
   doit afficher `healthy`.
2. **CORS** :
   ```bash
   curl -si -H "Origin: https://kwizora.com" https://api.kwizora.com/api/health \
     | grep -i access-control-allow-origin
   # access-control-allow-origin: https://kwizora.com
   ```
3. **Socket.io, transport polling** (même domaine, même port) :
   ```bash
   curl -s "https://api.kwizora.com/socket.io/?EIO=4&transport=polling"
   # 0{"sid":"…","upgrades":["websocket"],…}
   ```
4. **WebSocket** à travers Traefik :
   ```bash
   npx -y wscat -c "wss://api.kwizora.com/socket.io/?EIO=4&transport=websocket"
   # reçoit 0{"sid":"…"} ; Ctrl+C pour quitter
   ```
5. **Supabase depuis le backend** : sur le frontend (`https://kwizora.com`),
   créer un compte enseignant, créer un quiz avec une image, lancer une
   session et la rejoindre depuis un téléphone. Une erreur à ce stade pointe
   en général vers `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, une migration
   manquante ou le bucket absent (journaux : Coolify → application →
   **Logs**).
6. **Supabase public** : `curl -i https://supabase.kwizora.com/rest/v1/`
   répond (401 sans clé : normal) avec un certificat valide.

## 8. Exploitation

- **Mise à jour** : merge sur `main` → redéploiement (automatique via
  l'application GitHub de Coolify, sinon bouton **Redeploy**). Appliquer les
  migrations avant.
- **Retour arrière** : Coolify → application → **Deployments**, redéployer
  une version précédente (attention aux migrations déjà appliquées, qui ne
  sont pas annulées).
- **Sauvegardes** : configurer les sauvegardes planifiées de la base du
  service Supabase dans Coolify (vers un stockage S3 externe de préférence)
  et tester une restauration. **TODO (mainteneur)** : reporter le choix dans
  [hebergement.md](hebergement.md).
- **Journaux** : la durée de conservation dépend de Docker sur le VPS ; à
  reporter dans [hebergement.md](hebergement.md).
