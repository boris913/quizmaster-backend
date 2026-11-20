-- ============================================================
-- Migration 005 — Types de question et images (issue #7)
--   - questions.type : ajoute 'true_false', 'ordering', 'short_answer',
--     'poll' aux types 'single' et 'multiple' (contrainte nommée
--     questions_type_check, qui remplace le CHECK anonyme du schéma initial).
--   - questions.image_url : URL facultative de l'image de la question
--     (bucket Supabase Storage "question-images", voir migrations/README.md),
--     http(s), 2048 caractères au plus.
--   - un sondage (poll) n'a jamais de bonne réponse (correct_answers vide).
-- Sémantique de correct_answers par type : voir
-- src/common/utils/question-types.util.ts.
-- Idempotente : peut être rejouée sans erreur.
-- ============================================================

ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_url TEXT NULL;

-- Retire tout CHECK portant sur questions.type (le CHECK en ligne du schéma
-- initial s'appelle questions_type_check par défaut, mais son nom n'est pas
-- garanti), puis recrée la contrainte nommée avec les six types.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'questions'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ~* '\mtype\M'
      AND pg_get_constraintdef(con.oid) ILIKE '%''single''%'
  LOOP
    EXECUTE format('ALTER TABLE questions DROP CONSTRAINT %I', c.conname);
  END LOOP;

  ALTER TABLE questions
    ADD CONSTRAINT questions_type_check
    CHECK (type IN (
      'single', 'multiple', 'true_false', 'ordering', 'short_answer', 'poll'
    ));
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'questions_image_url_check'
      AND conrelid = 'questions'::regclass
  ) THEN
    ALTER TABLE questions
      ADD CONSTRAINT questions_image_url_check
      CHECK (
        image_url IS NULL
        OR (char_length(image_url) <= 2048 AND image_url ~* '^https?://')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'questions_poll_no_answer_check'
      AND conrelid = 'questions'::regclass
  ) THEN
    ALTER TABLE questions
      ADD CONSTRAINT questions_poll_no_answer_check
      CHECK (type <> 'poll' OR cardinality(correct_answers) = 0);
  END IF;
END $$;
