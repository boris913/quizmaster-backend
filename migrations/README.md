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
