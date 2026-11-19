-- ============================================================
-- Migration 002 — Purge RGPD : anonymisation des participants (issue #9)
--
-- Après N jours (30 par défaut) suivant la fin d'une session, les
-- participants sont anonymisés :
--   - `pseudo`    → 'Joueur ' || rang dans la session (1 = meilleur score) ;
--   - `socket_id` → NULL.
-- Rien n'est supprimé : scores, réponses (`participant_answers`), temps de
-- réponse et liens session/question sont conservés, donc les statistiques
-- agrégées (taux de réussite par question, distribution des scores…) restent
-- utilisables. La session est marquée `anonymized_at` pour ne pas être
-- retraitée.
--
-- Idempotente : peut être rejouée sans erreur.
-- Ne dépend d'aucune colonne/statut ajouté par d'autres migrations en cours
-- (ex. statut participant `kicked`) : la fonction ne lit ni n'écrit `status`
-- des participants.
--
-- ------------------------------------------------------------
-- PLANIFICATION (pg_cron)
-- ------------------------------------------------------------
-- Si l'extension pg_cron est activée, cette migration planifie une exécution
-- quotidienne (03:15 UTC) du job `quizmaster-anonymize-participants`.
-- Sinon, elle affiche un NOTICE et ne planifie rien. Pour l'activer :
--   1. Supabase → Database → Extensions → rechercher « pg_cron » → Enable
--      (ou : CREATE EXTENSION IF NOT EXISTS pg_cron;) ;
--   2. rejouer ce fichier dans le SQL Editor ;
--   3. vérifier : SELECT jobid, jobname, schedule, command FROM cron.job;
--   4. historique : SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
-- Exécution manuelle : SELECT public.anonymize_old_participants(30);
-- Désactiver : SELECT cron.unschedule('quizmaster-anonymize-participants');
-- Pour changer la durée de conservation, modifier l'appel planifié
-- (paramètre `retention_days`) et la documentation (docs/registre-traitement.md).
-- ============================================================

-- Marqueur d'anonymisation (NULL = pas encore anonymisée)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

-- Index partiel pour retrouver rapidement les sessions terminées à traiter
CREATE INDEX IF NOT EXISTS idx_sessions_pending_anonymization
  ON sessions (ended_at)
  WHERE status = 'finished' AND anonymized_at IS NULL;

-- ------------------------------------------------------------
-- Fonction d'anonymisation
-- Renvoie le nombre de participants anonymisés.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anonymize_old_participants(retention_days INT DEFAULT 30)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  affected INTEGER := 0;
  session_ids UUID[];
BEGIN
  IF retention_days IS NULL OR retention_days < 0 THEN
    RAISE EXCEPTION 'retention_days doit être >= 0 (reçu : %)', retention_days;
  END IF;

  -- Sessions terminées depuis plus de `retention_days` jours, pas encore
  -- anonymisées. Repli sur started_at / created_at si ended_at est absent.
  SELECT COALESCE(array_agg(t.id), '{}') INTO session_ids
  FROM (
    SELECT s.id
    FROM sessions s
    WHERE s.status = 'finished'
      AND s.anonymized_at IS NULL
      AND COALESCE(s.ended_at, s.started_at, s.created_at)
          < NOW() - make_interval(days => retention_days)
    FOR UPDATE SKIP LOCKED
  ) t;

  IF cardinality(session_ids) = 0 THEN
    RETURN 0;
  END IF;

  -- Étape 1 : pseudo temporaire unique (évite une collision transitoire avec
  -- la contrainte UNIQUE(session_id, pseudo) si un élève s'appelait déjà
  -- « Joueur 2 », par exemple).
  UPDATE participants p
  SET pseudo = '~' || p.id::text
  WHERE p.session_id = ANY(session_ids);

  -- Étape 2 : pseudo définitif selon le rang (score décroissant, puis ordre
  -- d'arrivée) et suppression de l'identifiant de socket.
  WITH ranked AS (
    SELECT
      p.id,
      ROW_NUMBER() OVER (
        PARTITION BY p.session_id
        ORDER BY p.score DESC NULLS LAST, p.joined_at ASC NULLS LAST, p.id
      ) AS rang
    FROM participants p
    WHERE p.session_id = ANY(session_ids)
  )
  UPDATE participants p
  SET pseudo = 'Joueur ' || r.rang,
      socket_id = NULL
  FROM ranked r
  WHERE p.id = r.id;

  GET DIAGNOSTICS affected = ROW_COUNT;

  UPDATE sessions s
  SET anonymized_at = NOW()
  WHERE s.id = ANY(session_ids);

  RETURN affected;
END;
$$;

COMMENT ON FUNCTION public.anonymize_old_participants(INT) IS
  'RGPD (issue #9) : anonymise pseudo et socket_id des participants des sessions terminées depuis plus de retention_days jours. Conserve scores et réponses.';

-- La fonction ne doit pas être appelable via l'API publique (PostgREST /rpc)
-- avec les clés anon/authenticated. Le backend (service_role) et pg_cron
-- (postgres) gardent l'accès.
REVOKE ALL ON FUNCTION public.anonymize_old_participants(INT) FROM PUBLIC;
DO $$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.anonymize_old_participants(INT) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.anonymize_old_participants(INT) TO service_role;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- Planification quotidienne (uniquement si pg_cron est activé)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Idempotent : on retire l'éventuel job existant avant de le recréer
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'quizmaster-anonymize-participants';

    PERFORM cron.schedule(
      'quizmaster-anonymize-participants',
      '15 3 * * *',
      'SELECT public.anonymize_old_participants(30);'
    );
    RAISE NOTICE 'pg_cron : job quizmaster-anonymize-participants planifié (tous les jours à 03:15 UTC).';
  ELSE
    RAISE NOTICE 'pg_cron non activé : aucune planification. Activez l''extension pg_cron (Supabase → Database → Extensions) puis rejouez cette migration. Voir l''en-tête du fichier.';
  END IF;
END
$$;
