-- ============================================================
-- Migration 007 — Duplication et partage de quiz par lien (issue #12)
--
--   quizzes
--     - share_token    : jeton de partage public (32 caractères base64url,
--                        192 bits d'aléa, généré par le serveur avec
--                        `crypto.randomBytes`). NULL = quiz non partagé.
--                        Régénéré par POST /api/quizzes/:id/share, remis à
--                        NULL (révocation) par DELETE /api/quizzes/:id/share.
--     - source_quiz_id : quiz d'origine d'une copie (duplication ou copie
--                        depuis un lien de partage). Simple trace : la copie
--                        n'est jamais modifiée par l'original, et la
--                        suppression de l'original remet la colonne à NULL.
--
-- Idempotente : peut être rejouée sans erreur.
-- ============================================================

ALTER TABLE quizzes
  ADD COLUMN IF NOT EXISTS share_token VARCHAR(32) NULL;

ALTER TABLE quizzes
  ADD COLUMN IF NOT EXISTS source_quiz_id UUID NULL
    REFERENCES quizzes(id) ON DELETE SET NULL;

-- Unicité du jeton (plusieurs NULL autorisés) ; sert aussi d'index de
-- recherche pour GET /api/quizzes/shared/:token.
CREATE UNIQUE INDEX IF NOT EXISTS quizzes_share_token_key
  ON quizzes (share_token);

-- Accélère le ON DELETE SET NULL à la suppression d'un quiz d'origine.
CREATE INDEX IF NOT EXISTS idx_quizzes_source_quiz_id
  ON quizzes (source_quiz_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quizzes_share_token_format_check'
      AND conrelid = 'quizzes'::regclass
  ) THEN
    ALTER TABLE quizzes
      ADD CONSTRAINT quizzes_share_token_format_check
      CHECK (share_token IS NULL OR share_token ~ '^[A-Za-z0-9_-]{32}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quizzes_source_quiz_not_self_check'
      AND conrelid = 'quizzes'::regclass
  ) THEN
    ALTER TABLE quizzes
      ADD CONSTRAINT quizzes_source_quiz_not_self_check
      CHECK (source_quiz_id IS NULL OR source_quiz_id <> id);
  END IF;
END
$$;
