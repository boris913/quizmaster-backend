-- ============================================================
-- Migration 008 — Quota de génération de quiz par IA (issue #11)
--
--   ai_generations : une ligne par génération réussie (ou en cours) de
--   `POST /api/quizzes/generate`. Sert uniquement au quota mensuel par
--   enseignant (AI_MONTHLY_QUOTA, 3 par défaut) : on compte les lignes de
--   l'utilisateur depuis le 1er du mois (UTC).
--
--   Une ligne est réservée juste avant l'appel au fournisseur IA, puis
--   supprimée si la génération échoue : un échec ne consomme pas de quota.
--
--   Aucun contenu n'est stocké (ni le texte du cours, ni les questions
--   générées) : seulement l'auteur, la date et le nombre de questions.
--
-- Idempotente : peut être rejouée sans erreur.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_generations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_generations_question_count_check'
      AND conrelid = 'ai_generations'::regclass
  ) THEN
    ALTER TABLE ai_generations
      ADD CONSTRAINT ai_generations_question_count_check
      CHECK (question_count >= 0 AND question_count <= 30);
  END IF;
END $$;

-- Comptage du quota : WHERE user_id = ? AND created_at >= <début du mois>
CREATE INDEX IF NOT EXISTS idx_ai_generations_user_created
  ON ai_generations (user_id, created_at);

-- RLS : accès réservé au backend (clé service_role), comme les autres tables.
ALTER TABLE ai_generations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON ai_generations;
CREATE POLICY "Service role full access" ON ai_generations
  FOR ALL TO service_role USING (true);
