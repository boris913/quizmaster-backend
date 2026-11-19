-- ============================================================
-- Test de la migration 002 (issue #9) sur des données factices.
--
-- À exécuter sur une base JETABLE (jamais en production), après
-- 000_initial_schema.sql et 002_retention_purge.sql. Exemple local :
--   psql -v ON_ERROR_STOP=1 -d quizmaster_test -f migrations/tests/002_retention_purge.test.sql
-- Tout se passe dans une transaction annulée (ROLLBACK) : aucune donnée
-- ne reste en base. Le script s'arrête sur la première assertion fausse.
-- ============================================================
BEGIN;

INSERT INTO users (id, pseudo, password_hash)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'prof_test', 'hash');

INSERT INTO quizzes (id, creator_id, title)
VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'Quiz test');

INSERT INTO questions (id, quiz_id, text, type, options, correct_answers, order_index)
VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1',
        'Q1', 'single', '[{"id":"A","text":"a"},{"id":"B","text":"b"}]', ARRAY['A'], 0);

-- s_old    : terminée il y a 40 jours → à anonymiser
-- s_recent : terminée il y a 5 jours  → conservée
-- s_active : active, créée il y a 60 jours → conservée (pas finished)
INSERT INTO sessions (id, quiz_id, creator_id, password, status, created_at, ended_at) VALUES
  ('00000000-0000-0000-0000-000000000d01', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'OLD001', 'finished', NOW() - INTERVAL '41 days', NOW() - INTERVAL '40 days'),
  ('00000000-0000-0000-0000-000000000d02', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'REC001', 'finished', NOW() - INTERVAL '6 days',  NOW() - INTERVAL '5 days'),
  ('00000000-0000-0000-0000-000000000d03', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'ACT001', 'active',   NOW() - INTERVAL '60 days', NULL);

-- Dans s_old, « Joueur 2 » est un vrai pseudo qui deviendra « Joueur 1 » :
-- vérifie l'absence de collision avec UNIQUE(session_id, pseudo).
INSERT INTO participants (id, session_id, pseudo, score, socket_id, joined_at) VALUES
  ('00000000-0000-0000-0000-000000000e01', '00000000-0000-0000-0000-000000000d01', 'Joueur 2',     900, 'sock-1', NOW() - INTERVAL '41 days'),
  ('00000000-0000-0000-0000-000000000e02', '00000000-0000-0000-0000-000000000d01', 'Alice Martin', 500, 'sock-2', NOW() - INTERVAL '41 days'),
  ('00000000-0000-0000-0000-000000000e03', '00000000-0000-0000-0000-000000000d01', 'Bob',          100, NULL,     NOW() - INTERVAL '41 days'),
  ('00000000-0000-0000-0000-000000000e04', '00000000-0000-0000-0000-000000000d02', 'Chloé',        300, 'sock-4', NOW() - INTERVAL '6 days'),
  ('00000000-0000-0000-0000-000000000e05', '00000000-0000-0000-0000-000000000d03', 'David',        200, 'sock-5', NOW() - INTERVAL '60 days');

INSERT INTO participant_answers (participant_id, session_id, question_id, answers, time_taken_ms, points_earned, is_correct) VALUES
  ('00000000-0000-0000-0000-000000000e01', '00000000-0000-0000-0000-000000000d01', '00000000-0000-0000-0000-0000000000c1', ARRAY['A'], 1200, 900, TRUE),
  ('00000000-0000-0000-0000-000000000e02', '00000000-0000-0000-0000-000000000d01', '00000000-0000-0000-0000-0000000000c1', ARRAY['A'], 5000, 500, TRUE),
  ('00000000-0000-0000-0000-000000000e03', '00000000-0000-0000-0000-000000000d01', '00000000-0000-0000-0000-0000000000c1', ARRAY['B'], 9000, 100, FALSE);

DO $$
DECLARE
  n INTEGER;
BEGIN
  -- Paramètre invalide
  BEGIN
    PERFORM anonymize_old_participants(-1);
    RAISE EXCEPTION 'ÉCHEC : retention_days négatif accepté';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'ÉCHEC%' THEN RAISE; END IF;
  END;

  n := anonymize_old_participants(30);
  ASSERT n = 3, format('3 participants anonymisés attendus, obtenu %s', n);

  -- Pseudos remplacés par le rang (score décroissant), socket_id effacé
  ASSERT (SELECT pseudo FROM participants WHERE id = '00000000-0000-0000-0000-000000000e01') = 'Joueur 1', 'e01 doit être Joueur 1';
  ASSERT (SELECT pseudo FROM participants WHERE id = '00000000-0000-0000-0000-000000000e02') = 'Joueur 2', 'e02 doit être Joueur 2';
  ASSERT (SELECT pseudo FROM participants WHERE id = '00000000-0000-0000-0000-000000000e03') = 'Joueur 3', 'e03 doit être Joueur 3';
  ASSERT NOT EXISTS (SELECT 1 FROM participants WHERE session_id = '00000000-0000-0000-0000-000000000d01' AND socket_id IS NOT NULL), 'socket_id doit être NULL';

  -- Statistiques conservées
  ASSERT (SELECT SUM(score) FROM participants WHERE session_id = '00000000-0000-0000-0000-000000000d01') = 1500, 'scores conservés';
  ASSERT (SELECT COUNT(*) FROM participant_answers WHERE session_id = '00000000-0000-0000-0000-000000000d01') = 3, 'réponses conservées';
  ASSERT (SELECT AVG(time_taken_ms)::int FROM participant_answers WHERE session_id = '00000000-0000-0000-0000-000000000d01') = 5067, 'temps conservés';

  -- Session marquée, autres sessions intactes
  ASSERT (SELECT anonymized_at IS NOT NULL FROM sessions WHERE id = '00000000-0000-0000-0000-000000000d01'), 's_old marquée';
  ASSERT (SELECT pseudo FROM participants WHERE id = '00000000-0000-0000-0000-000000000e04') = 'Chloé', 'session récente intacte';
  ASSERT (SELECT socket_id FROM participants WHERE id = '00000000-0000-0000-0000-000000000e04') = 'sock-4', 'socket récent intact';
  ASSERT (SELECT pseudo FROM participants WHERE id = '00000000-0000-0000-0000-000000000e05') = 'David', 'session active intacte';

  -- Idempotence : un second passage ne retraite rien
  n := anonymize_old_participants(30);
  ASSERT n = 0, format('second passage : 0 attendu, obtenu %s', n);

  -- retention_days = 0 : la session récente devient éligible
  n := anonymize_old_participants(0);
  ASSERT n = 1, format('retention 0 : 1 attendu, obtenu %s', n);
  ASSERT (SELECT pseudo FROM participants WHERE id = '00000000-0000-0000-0000-000000000e04') = 'Joueur 1', 'e04 anonymisé';

  -- Cascade : supprimer une session efface participants et réponses
  DELETE FROM sessions WHERE id = '00000000-0000-0000-0000-000000000d01';
  ASSERT NOT EXISTS (SELECT 1 FROM participants WHERE session_id = '00000000-0000-0000-0000-000000000d01'), 'cascade participants';
  ASSERT NOT EXISTS (SELECT 1 FROM participant_answers WHERE session_id = '00000000-0000-0000-0000-000000000d01'), 'cascade réponses';

  RAISE NOTICE 'OK : tous les tests de 002_retention_purge passent.';
END
$$;

ROLLBACK;
