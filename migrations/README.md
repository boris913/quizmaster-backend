# Migrations SQL

Le schéma de la base Supabase évolue par **fichiers SQL incrémentaux** rangés ici.
`supabase-schema.sql` (à la racine) reste le schéma de référence initial ; il n'est
plus modifié.

## Convention de nommage

```
NNN_description_courte.sql
```

- `NNN` : numéro sur 3 chiffres, strictement croissant (`000`, `001`, `002`…).
- `description_courte` : en `snake_case`, décrit le changement
  (ex. `001_add_question_explanation.sql`).
- Prenez le numéro suivant le plus élevé présent sur `main`. Si deux PR
  prennent le même numéro, la seconde à être mergée renumérote son fichier.

## Règles

1. **Ne jamais modifier une migration déjà mergée.** Tout changement passe par un
   nouveau fichier (y compris pour corriger une migration précédente).
2. **Idempotence** : une migration doit pouvoir être rejouée sans erreur.
   - `CREATE TABLE IF NOT EXISTS ...`
   - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`
   - `CREATE INDEX IF NOT EXISTS ...`
   - `CREATE OR REPLACE FUNCTION ...`
   - `DROP TRIGGER IF EXISTS ...` avant `CREATE TRIGGER ...`
   - `DROP POLICY IF EXISTS ...` avant `CREATE POLICY ...`
   - pour un type énuméré ou une contrainte : bloc `DO $$ ... $$` qui teste
     son existence avant de le créer.
3. Une migration = un changement cohérent, avec un en-tête de commentaire qui
   indique l'issue concernée.
4. Si la migration ajoute une table, activer la RLS et ajouter la policy
   `service_role`, comme dans `000_initial_schema.sql`.
5. Mettre à jour les types TypeScript (`src/common/types`) dans la même PR.

> `000_initial_schema.sql` est l'exception : c'est la copie historique du schéma,
> qui n'est pas idempotente. Elle ne s'applique qu'à une base vide.

## Application (SQL Editor Supabase)

Il n'y a pas d'outil de migration automatique : les fichiers sont appliqués à la
main dans **Supabase → SQL Editor**.

- **Nouvelle base** : exécuter tous les fichiers dans l'ordre croissant des
  numéros, en commençant par `000_initial_schema.sql`.
- **Base existante** : exécuter, dans l'ordre, uniquement les migrations pas
  encore appliquées (grâce à l'idempotence, rejouer une migration déjà passée est
  sans effet).
- Après un merge qui ajoute une migration, l'appliquer sur chaque environnement
  (dev, prod) **avant** de déployer le code qui en dépend.

Exemple de squelette :

```sql
-- ============================================================
-- Migration 001 — Explication des réponses (issue #4)
-- ============================================================
ALTER TABLE questions ADD COLUMN IF NOT EXISTS explanation TEXT;
```

## Supabase Storage : bucket `question-images` (issue #7)

Les images de question sont stockées dans le bucket Supabase Storage
`question-images`. Un bucket n'est pas une table du schéma `public` : il n'est
pas créé par une migration numérotée. À faire **une fois par environnement**
(dev, prod), avant de déployer le code de l'issue #7.

### Choix : bucket public, écriture réservée au serveur

- **Lecture publique** : l'URL `public_url` enregistrée dans
  `questions.image_url` est stable et lisible sans jeton par les joueurs
  (anonymes, sans compte) pendant toute la durée de vie du quiz. Un bucket
  privé imposerait de signer une URL de lecture à chaque `question:start`,
  avec une expiration à gérer (sessions longues, rapports, réimports).
- **Pas de listage** : aucune policy `SELECT` sur `storage.objects` pour
  `anon` / `authenticated`. On ne peut lire une image qu'en connaissant son
  chemin, imposé par le serveur et non devinable (`<quizId>/<uuid>.<ext>`).
- **Écriture réservée au serveur** : aucune policy `INSERT` / `UPDATE` /
  `DELETE` pour `anon` / `authenticated`. Le backend (clé `service_role`, qui
  contourne la RLS) génère une URL signée d'upload à usage unique pour un
  chemin précis (`POST /api/quizzes/:id/questions/image-upload-url`). Le
  navigateur envoie le fichier directement à Supabase avec cette URL.
- **Contrôles** : le serveur refuse un type ou une taille déclarés non
  conformes ; le bucket impose en plus `allowed_mime_types` et
  `file_size_limit` au fichier réellement envoyé.
- Contenu attendu : illustrations de quiz, **pas de données personnelles**
  (photos d'élèves, etc.) : elles seraient lisibles par toute personne
  disposant du lien.

### Création (SQL Editor Supabase)

Script idempotent (le schéma `storage` est géré par Supabase ; l'insertion
dans `storage.buckets` est la méthode documentée pour créer un bucket en SQL) :

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'question-images',
  'question-images',
  TRUE,
  2097152, -- 2 Mo
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
```

Aucune policy à créer sur `storage.objects` (voir ci-dessus). Vérifier qu'il
n'en existe pas qui ouvrirait l'écriture ou le listage du bucket :

```sql
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects';
```

### Alternative : tableau de bord

**Storage → New bucket** : nom `question-images`, **Public bucket** coché,
**Restrict file upload size** = 2 MB, **Allowed MIME types** =
`image/png, image/jpeg, image/webp, image/gif`. Ne pas ajouter de policy.

### Variables d'environnement

Aucune nouvelle variable : le backend utilise `SUPABASE_URL` et
`SUPABASE_SERVICE_ROLE_KEY` (déjà requises).
