// ============================================================
// Types globaux partagés dans tout le backend
// ============================================================

export interface QuizOption {
  id: string; // 'A', 'B', 'C', 'D'
  text: string;
}

export interface Question {
  id: string;
  quiz_id: string;
  text: string;
  type: 'single' | 'multiple';
  options: QuizOption[];
  correct_answers: string[];
  max_points: number;
  timer_seconds: number;
  order_index: number;
  created_at: string;
}

export interface Quiz {
  id: string;
  creator_id: string;
  title: string;
  description?: string;
  global_timer_seconds: number;
  use_global_timer: boolean;
  total_questions: number;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  quiz_id: string;
  creator_id: string;
  password: string;
  status: 'waiting' | 'active' | 'paused' | 'finished';
  current_question_index: number;
  question_start_time?: string;
  started_at?: string;
  ended_at?: string;
  created_at: string;
}

export interface Participant {
  id: string;
  session_id: string;
  pseudo: string;
  score: number;
  status: 'waiting' | 'answering' | 'answered' | 'timeout' | 'disconnected';
  socket_id?: string;
  joined_at: string;
}

export interface ParticipantAnswer {
  id: string;
  participant_id: string;
  session_id: string;
  question_id: string;
  answers: string[];
  time_taken_ms?: number;
  points_earned: number;
  is_correct: boolean;
  status: 'answered' | 'timeout' | 'skipped';
  answered_at: string;
}

export interface LeaderboardEntry {
  rank: number;
  participant_id: string;
  pseudo: string;
  score: number;
  last_points: number;
  answered_current?: boolean;
}

// Payloads WebSocket émis par le serveur
export interface WsQuestionStartPayload {
  question: Omit<Question, 'correct_answers'>; // Sans les réponses !
  question_number: number;
  total_questions: number;
  timer_seconds: number;
}

export interface WsQuestionEndPayload {
  correct_answers: string[];
  leaderboard: LeaderboardEntry[];
  question_id: string;
}

export interface WsAnswerResultPayload {
  is_correct: boolean;
  points_earned: number;
  time_taken_ms: number;
  correct_answers: string[];
}

export interface WsLeaderboardUpdatePayload {
  leaderboard: LeaderboardEntry[];
}

export interface WsQuizFinishedPayload {
  final_leaderboard: LeaderboardEntry[];
  total_questions: number;
}

export interface WsParticipantJoinedPayload {
  participant: Participant;
  total_participants: number;
}
