-- ============================================================
-- Migration 003 — Explication des réponses (issue #6)
--   - questions.explanation : texte facultatif (≤ 500 caractères),
--     révélé aux joueurs uniquement à la clôture de la question
--     (événement socket "question:reveal").
-- Idempotente : peut être rejouée sans erreur.
-- ============================================================

ALTER TABLE questions ADD COLUMN IF NOT EXISTS explanation TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'questions_explanation_length_check'
      AND conrelid = 'questions'::regclass
  ) THEN
    ALTER TABLE questions
      ADD CONSTRAINT questions_explanation_length_check
      CHECK (explanation IS NULL OR char_length(explanation) <= 500);
  END IF;
END $$;
