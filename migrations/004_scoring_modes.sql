-- ============================================================
-- Migration 004 — Modes de score et classement masqué (issue #8)
--   - sessions.scoring_mode : 'speed' (défaut, points dégressifs avec le
--     temps) ou 'accuracy' (toute bonne réponse dans le temps = max_points)
--   - sessions.show_leaderboard : TRUE (défaut). À FALSE, aucun classement
--     ni rang n'est envoyé aux joueurs ; le créateur reçoit tout.
-- Les sessions existantes prennent les valeurs par défaut (comportement
-- inchangé).
-- Idempotente : peut être rejouée sans erreur.
-- ============================================================

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS scoring_mode VARCHAR(10) NOT NULL DEFAULT 'speed';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS show_leaderboard BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_scoring_mode_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_scoring_mode_check
      CHECK (scoring_mode IN ('speed', 'accuracy'));
  END IF;
END $$;
