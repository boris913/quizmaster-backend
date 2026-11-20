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
  /** Explication facultative (migration 003, issue #6). */
  explanation?: string | null;
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
  /** Mode de choix des pseudos (issue #5). */
  nickname_mode: "free" | "generated";
  /** Mode de score (issue #8, migration 004). */
  scoring_mode: "speed" | "accuracy";
  /** Classement visible par les joueurs (issue #8, migration 004). */
  show_leaderboard: boolean;
  question_start_time?: string;
  started_at?: string;
  ended_at?: string;
  /** Date d'anonymisation des participants (migration 002), sinon null. */
  anonymized_at?: string | null;
  created_at: string;
}

export interface Participant {
  id: string;
  session_id: string;
  pseudo: string;
  score: number;
  status:
    | "waiting"
    | "answering"
    | "answered"
    | "timeout"
    | "disconnected"
    | "kicked";
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
  question: Omit<Question, "correct_answers" | "explanation">; // Sans les réponses !
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

/**
 * "question:stats" (issue #6) : room créateur uniquement, une fois à la
 * clôture de la question (timeout ou tous les participants actifs ont
 * répondu). Participants "kicked" et "disconnected" exclus.
 */
export interface WsQuestionStatsPayload {
  questionId: string;
  /** Nombre de participants ayant coché chaque option (toutes les options présentes, 0 par défaut). */
  distribution: Record<string, number>;
  correctAnswers: string[];
  /** Pourcentage entier (0-100) de bonnes réponses parmi totalParticipants. */
  accuracy: number;
  answeredCount: number;
  totalParticipants: number;
}

/**
 * "question:reveal" (issue #6) : envoyé à chaque joueur, une fois à la
 * clôture. Seul événement joueur qui porte la bonne réponse et l'explication.
 */
export interface WsQuestionRevealPayload {
  questionId: string;
  correctAnswers: string[];
  explanation: string | null;
  yourAnswers: string[];
  isCorrect: boolean;
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

// ============================================================
// CLASSEMENT MASQUÉ (issue #8, sessions.show_leaderboard = false)
// ============================================================

/**
 * "player:score" : envoyé à chaque joueur à la clôture de chaque question,
 * uniquement si le classement est masqué. Remplace le classement.
 */
export interface WsPlayerScorePayload {
  /** Score total du joueur. */
  score: number;
  /** Nombre de bonnes réponses du joueur sur les questions jouées. */
  correctCount: number;
  /**
   * Précision de la classe, pourcentage entier 0-100 : bonnes réponses /
   * réponses attendues (une par participant présent à la clôture de chaque
   * question jouée, absences comprises). Participants exclus ignorés.
   */
  classAccuracy: number;
}

/**
 * "quiz:finished" côté joueur quand le classement est masqué (remplace
 * `WsQuizFinishedPayload`). Le créateur reçoit le payload habituel.
 */
export interface WsHiddenQuizFinishedPayload {
  classAccuracy: number;
  yourScore: number;
}

/** "answer:result" quand le classement est masqué : sans rang ni écarts. */
export type WsHiddenAnswerResultPayload = Omit<
  WsAnswerResultPayload,
  "rank" | "total_participants" | "gap_to_next" | "gap_to_podium" | "on_podium"
>;

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

// Exclusion d'un participant par le créateur (issue #5)
export interface WsCreatorKickPayload {
  sessionId: string;
  participantId: string;
}

// ============================================================
// MODÉRATION DES PSEUDOS (issue #5)
// ============================================================

/** Serveur → joueur exclu. */
export interface WsParticipantKickedPayload {
  reason: "kicked";
}

/** Réponse de GET /api/sessions/join/nicknames?code=... */
export interface NicknameSuggestionsResponse {
  nickname_mode: "free" | "generated";
  suggestions: string[];
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
