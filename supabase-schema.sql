-- ============================================================
-- QuizMaster — Schéma Supabase (PostgreSQL)
-- À exécuter dans l'éditeur SQL de Supabase
-- ============================================================

-- Extension pour UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLE: users
-- Créateurs de quiz
-- ============================================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pseudo VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE: quizzes
-- ============================================================
CREATE TABLE quizzes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  global_timer_seconds INTEGER DEFAULT 30,
  use_global_timer BOOLEAN DEFAULT TRUE,
  total_questions INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE: questions
-- ============================================================
CREATE TABLE questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('single', 'multiple')),
  options JSONB NOT NULL,
  -- options format: [{"id": "A", "text": "Londres"}, ...]
  correct_answers TEXT[] NOT NULL,
  -- correct_answers format: ["A"] or ["A", "B"]
  max_points INTEGER DEFAULT 100,
  timer_seconds INTEGER DEFAULT 30,
  order_index INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE: sessions
-- Instance active d'un quiz
-- ============================================================
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password VARCHAR(10) NOT NULL UNIQUE,
  status VARCHAR(20) DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'paused', 'finished')),
  current_question_index INTEGER DEFAULT -1,
  question_start_time TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index pour lookup rapide par password
CREATE INDEX idx_sessions_password ON sessions(password);
CREATE INDEX idx_sessions_status ON sessions(status);

-- ============================================================
-- TABLE: participants
-- Joueurs dans une session
-- ============================================================
CREATE TABLE participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pseudo VARCHAR(50) NOT NULL,
  score INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'waiting' CHECK (status IN ('waiting', 'answering', 'answered', 'timeout', 'disconnected')),
  socket_id TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, pseudo)
);

CREATE INDEX idx_participants_session ON participants(session_id);

-- ============================================================
-- TABLE: participant_answers
-- Réponses des participants
-- ============================================================
CREATE TABLE participant_answers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  answers TEXT[] NOT NULL,
  time_taken_ms INTEGER,
  points_earned INTEGER DEFAULT 0,
  is_correct BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'answered' CHECK (status IN ('answered', 'timeout', 'skipped')),
  answered_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_answers_participant ON participant_answers(participant_id);
CREATE INDEX idx_answers_session_question ON participant_answers(session_id, question_id);

-- ============================================================
-- FONCTIONS & TRIGGERS
-- ============================================================

-- Mise à jour automatique de updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_quizzes_updated_at BEFORE UPDATE ON quizzes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Mise à jour du total_questions automatique
CREATE OR REPLACE FUNCTION update_quiz_total_questions()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE quizzes SET total_questions = total_questions + 1 WHERE id = NEW.quiz_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE quizzes SET total_questions = total_questions - 1 WHERE id = OLD.quiz_id;
  END IF;
  RETURN NULL;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_quiz_question_count
  AFTER INSERT OR DELETE ON questions
  FOR EACH ROW EXECUTE FUNCTION update_quiz_total_questions();

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE participant_answers ENABLE ROW LEVEL SECURITY;

-- Politique: accès complet via service_role (backend)
-- Le backend utilise la clé service_role qui bypass RLS
-- Ces politiques couvrent l'accès anon/authenticated si besoin

CREATE POLICY "Service role full access" ON users FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON quizzes FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON questions FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON sessions FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON participants FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON participant_answers FOR ALL TO service_role USING (true);
