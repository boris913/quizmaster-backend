-- ============================================================
-- Migration 001 — Modération des pseudos (issue #5)
--   - sessions.nickname_mode : 'free' (pseudo libre filtré) ou
--     'generated' (pseudo choisi parmi les propositions du serveur)
--   - participants.status : ajout de 'kicked' (exclusion par le créateur)
-- Idempotente : peut être rejouée sans erreur.
-- ============================================================

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS nickname_mode VARCHAR(10) NOT NULL DEFAULT 'free';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_nickname_mode_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_nickname_mode_check
      CHECK (nickname_mode IN ('free', 'generated'));
  END IF;
END $$;

-- La contrainte d'origine (définie en ligne dans 000) porte le nom généré
-- par PostgreSQL : participants_status_check. On la remplace.
ALTER TABLE participants DROP CONSTRAINT IF EXISTS participants_status_check;
ALTER TABLE participants
  ADD CONSTRAINT participants_status_check
  CHECK (status IN ('waiting', 'answering', 'answered', 'timeout', 'disconnected', 'kicked'));
