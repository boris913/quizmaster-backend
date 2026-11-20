-- ============================================================
-- Migration 006 — Mode devoir asynchrone (issue #10)
--
--   sessions
--     - mode              : 'live' (défaut, partie pilotée en direct) ou
--                           'async' (devoir : chaque élève avance seul)
--     - due_at            : échéance du devoir (NULL pour une session live)
--     - show_explanations : 'each' (défaut, verdict + explication après
--                           chaque réponse) ou 'end' (révélés à la fin du
--                           devoir de l'élève)
--   participants
--     - question_sent_at  : heure serveur d'envoi de la question en cours
--                           (base du temps de réponse, NULL si aucune)
--     - current_index     : position, dans l'ordre propre à l'élève, de la
--                           question en cours (ou de la prochaine)
--     - resume_token      : empreinte SHA-256 (hex, 64 caractères) du jeton
--                           de reprise. Le jeton lui-même n'est jamais stocké.
--   participant_answers
--     - unicité (participant_id, question_id) : une seule réponse par
--       question et par participant, garantie par la base.
--
-- Les sessions existantes prennent les valeurs par défaut (live, 'each') :
-- comportement inchangé.
-- Idempotente : peut être rejouée sans erreur.
-- ============================================================

-- ------------------------------------------------------------
-- sessions
-- ------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS mode VARCHAR(10) NOT NULL DEFAULT 'live';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ NULL;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS show_explanations VARCHAR(10) NOT NULL DEFAULT 'each';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_mode_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_mode_check
      CHECK (mode IN ('live', 'async'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_show_explanations_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_show_explanations_check
      CHECK (show_explanations IN ('each', 'end'));
  END IF;

  -- Un devoir a toujours une échéance ; une session live n'en a pas.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_async_due_at_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_async_due_at_check
      CHECK ((mode = 'async') = (due_at IS NOT NULL));
  END IF;
END $$;

-- Liste des devoirs à échéance (tableau de bord, purge éventuelle)
CREATE INDEX IF NOT EXISTS idx_sessions_async_due_at
  ON sessions (due_at)
  WHERE mode = 'async';

-- ------------------------------------------------------------
-- participants
-- ------------------------------------------------------------
ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS question_sent_at TIMESTAMPTZ NULL;

ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS current_index INT NOT NULL DEFAULT 0;

ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS resume_token VARCHAR(64) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'participants_current_index_check'
      AND conrelid = 'participants'::regclass
  ) THEN
    ALTER TABLE participants
      ADD CONSTRAINT participants_current_index_check
      CHECK (current_index >= 0);
  END IF;
END $$;

-- Recherche du participant par empreinte de jeton (unique quand présente)
CREATE UNIQUE INDEX IF NOT EXISTS participants_resume_token_key
  ON participants (resume_token)
  WHERE resume_token IS NOT NULL;

-- ------------------------------------------------------------
-- participant_answers : une seule réponse par question et par participant
-- ------------------------------------------------------------
-- L'index n'est créé que si la table ne contient aucun doublon : une base
-- qui en contiendrait (course réponse / timeout en direct, avant cette
-- migration) ne doit pas faire échouer la migration. Dans ce cas, un
-- WARNING est émis ; corriger les doublons puis rejouer ce fichier :
--   SELECT participant_id, question_id, COUNT(*)
--   FROM participant_answers
--   GROUP BY participant_id, question_id
--   HAVING COUNT(*) > 1;
DO $$
BEGIN
  IF to_regclass('public.participant_answers_participant_question_key') IS NOT NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM participant_answers
    GROUP BY participant_id, question_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING
      'participant_answers contient des doublons (participant_id, question_id) : index unique non créé. Corriger puis rejouer la migration 006.';
  ELSE
    CREATE UNIQUE INDEX participant_answers_participant_question_key
      ON participant_answers (participant_id, question_id);
  END IF;
END $$;
