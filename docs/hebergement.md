# Hébergement et localisation des données — Kwizora

> **Avertissement.** Ce document n'est pas un avis juridique. Les régions
> d'hébergement ci-dessous **n'ont pas été vérifiées** : elles doivent être
> confirmées par le mainteneur, puis le document relu par un DPO avant toute
> communication « conforme RGPD » ou « données hébergées en UE ».

## Composants

| Composant | Fournisseur | Région / pays | Statut |
|---|---|---|---|
| Base de données (PostgreSQL) | Supabase | **TODO (mainteneur) : à confirmer** | non vérifié |
| Sauvegardes de la base | Supabase | **TODO (mainteneur) : à confirmer** (en principe même région que le projet, à vérifier selon l'offre) | non vérifié |
| Backend NestJS + Socket.io | **TODO (mainteneur)** (le README cite Railway / Render comme exemples, sans confirmer le choix réel) | **TODO (mainteneur) : à confirmer** | non vérifié |
| Frontend Next.js | **TODO (mainteneur)** | **TODO (mainteneur) : à confirmer** | non vérifié |
| Journaux applicatifs | hébergeur du backend | **TODO (mainteneur)** : région et durée de conservation | non vérifié |

## Comment vérifier (à faire par le mainteneur)

1. **Supabase** : tableau de bord → *Project Settings* → *General* (ou
   *Infrastructure*) : relever la région du projet (ex. code `eu-west-…`,
   `eu-central-…`). La région est choisie à la création du projet et ne se
   change pas sans migration vers un nouveau projet.
2. **Hébergeur du backend** : relever la région du service dans ses réglages,
   ainsi que la durée de conservation des journaux.
3. **Hébergeur du frontend** : relever la région d'exécution (fonctions
   serveur) ; un CDN peut diffuser les fichiers statiques depuis plusieurs pays.
4. Pour chaque fournisseur : récupérer le DPA (accord de sous-traitance) et,
   si des données peuvent sortir de l'UE, le mécanisme de transfert
   (clauses contractuelles types, décision d'adéquation…).
5. Reporter les résultats dans le tableau ci-dessus **et** dans la section 7
   de [registre-traitement.md](registre-traitement.md).

## Configuration de production liée à la protection des données

| Élément | Où | Valeur attendue |
|---|---|---|
| `CORS_ORIGINS` | variables d'environnement du backend | URL(s) exacte(s) du frontend, séparées par des virgules, sans `/` final (ex. `https://kwizora.example.fr`) |
| `SUPABASE_SERVICE_ROLE_KEY` | variables d'environnement du backend uniquement | jamais dans le frontend, jamais commitée |
| Extension `pg_cron` | Supabase → Database → Extensions | activée, puis rejouer `migrations/002_retention_purge.sql` |
| Job `quizmaster-anonymize-participants` | `SELECT * FROM cron.job;` | présent, planifié `15 3 * * *` (UTC) |

Sans `CORS_ORIGINS` (ni l'ancienne variable `FRONTEND_URL`), le backend
n'autorise que `http://localhost:3000` et affiche un avertissement au
démarrage si `NODE_ENV=production`.
