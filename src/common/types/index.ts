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
  type: "single" | "multiple";
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
  status: "waiting" | "active" | "paused" | "finished";
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
  status: "waiting" | "answering" | "answered" | "timeout" | "disconnected";
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
  status: "answered" | "timeout" | "skipped";
  answered_at: string;
}

// ============================================================
// LEADERBOARD AVEC GAPS (AMÉLIORATION AUDIT #3)
// ============================================================

export interface LeaderboardEntry {
  rank: number;
  participant_id: string;
  pseudo: string;
  score: number;
  last_points: number;
  answered_current: boolean;
  gap_to_next: number | null; // Écart avec le devant
  gap_to_podium: number | null; // Distance du podium (3ème)
  on_podium: boolean; // Sur le podium ?
}

// ============================================================
// PAYLOADS WEBSOCKET (SERVEUR → CLIENT)
// ============================================================

// AMÉLIORATION AUDIT #1: Countdown 3-2-1-GO
export interface WsQuestionCountdownPayload {
  countdown: number; // 3, 2, 1
  message: string; // "Prêt ?", "Steady...", "GO !"
}

export interface WsQuestionStartPayload {
  question: Omit<Question, "correct_answers">; // Sans les réponses !
  question_number: number;
  total_questions: number;
  timer_seconds: number;
  started_at: number; // timestamp
}

export interface WsQuestionEndPayload {
  question_id: string;
  correct_answers: string[];
  leaderboard: LeaderboardEntry[];
}

// AMÉLIORATION AUDIT #3: Ajout des gaps dans le résultat
export interface WsAnswerResultPayload {
  is_correct: boolean;
  points_earned: number;
  max_points: number;
  time_taken_ms: number;
  correct_answers: string[];
  your_answer: string[];
  total_score: number;
  rank: number;
  total_participants: number;
  gap_to_next: number | null;
  gap_to_podium: number | null;
  on_podium: boolean;
  waiting_for_timer: boolean;
}

export interface WsLeaderboardUpdatePayload {
  leaderboard: LeaderboardEntry[];
  question_number: number;
  total_questions: number;
}

// ============================================================
// PAYLOAD FIN DE QUIZ PERSONNALISÉ (AMÉLIORATION AUDIT #2)
// ============================================================

export interface WsQuizFinishedPayload {
  final_leaderboard: LeaderboardEntry[];
  your_rank: number;
  your_score: number;
  is_winner: boolean;
  winner_pseudo: string | null;
  total_participants: number;
  total_questions: number;
  message: string; // Message personnalisé selon le rang
}

export interface WsParticipantJoinedPayload {
  participant: Participant;
  total_participants: number;
}

// ============================================================
// PAYLOADS WEBSOCKET (CLIENT → SERVEUR)
// ============================================================

export interface WsJoinSessionPayload {
  sessionId: string;
  participantId: string;
  role: "creator" | "participant";
}

export interface WsCreatorJoinPayload {
  sessionId: string;
  token: string; // JWT du créateur
}

export interface WsStartQuestionPayload {
  sessionId: string;
  questionIndex: number;
}

export interface WsSubmitAnswerPayload {
  sessionId: string;
  participantId: string;
  questionId: string;
  answers: string[];
  timeTakenMs: number;
}

export interface WsEndQuizPayload {
  sessionId: string;
}

// ============================================================
// PAYLOAD PROGRESSION PARTICIPANT (AMÉLIORATION AUDIT #5)
// ============================================================

export interface WsParticipantProgressPayload {
  participant_id: string;
  pseudo: string;
  answered_count: number;
  total_count: number;
  questions_answered: number;
  total_questions: number;
  progress_percentage: number;
}
