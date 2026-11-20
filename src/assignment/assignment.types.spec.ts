import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { SessionService } from "../session/session.service";
import { AssignmentService } from "./assignment.service";
import { generateResumeToken, hashResumeToken } from "./assignment.util";

/**
 * Intégration mode devoir (#10) × nouveaux types de questions (#7) : la
 * correction et la validation des réponses en devoir suivent les mêmes
 * règles que le direct (checkAnswer par type, sanitizeSubmittedAnswers).
 */

const NOW = Date.parse("2026-11-20T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const CODE = "ABC234";
const TOKEN = generateResumeToken();

const SHORT = {
  id: "44444444-4444-4444-8444-444444444444",
  text: "Capitale de l'Italie ?",
  type: "short_answer",
  options: [],
  correct_answers: ["Rome"],
  max_points: 100,
  timer_seconds: 20,
  order_index: 0,
  explanation: null,
};

const session = {
  id: "s1",
  quiz_id: "quiz1",
  status: "active",
  mode: "async",
  due_at: new Date(NOW + 24 * HOUR).toISOString(),
  scoring_mode: "accuracy",
  show_explanations: "each",
  quizzes: {
    title: "Géo",
    total_questions: 1,
    use_global_timer: false,
    global_timer_seconds: 30,
  },
};

const participant = {
  id: "p1",
  session_id: "s1",
  pseudo: "Alice",
  score: 0,
  status: "answering",
  current_index: 0,
  question_sent_at: new Date(NOW - 2000).toISOString(),
  resume_token: hashResumeToken(TOKEN),
};

describe("AssignmentService × types de questions (#7 + #10)", () => {
  let service: AssignmentService;
  let supabase: SupabaseMock;

  beforeEach(async () => {
    supabase = createSupabaseMock();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AssignmentService,
        SessionService,
        { provide: SUPABASE_CLIENT, useValue: supabase.client },
      ],
    }).compile();
    service = moduleRef.get(AssignmentService);
    // Copies fraîches : le service met à jour la progression du participant en place.
    supabase
      .mockResponse("sessions", { data: structuredClone(session) })
      .mockResponse("participants", { data: structuredClone(participant) })
      .mockResponse("questions", { data: [structuredClone(SHORT)] })
      .mockResponse("participant_answers", { data: [] });
  });

  it("réponse courte juste malgré casse, espaces et ponctuation finale", async () => {
    const res = await service.answer(
      CODE,
      TOKEN,
      { questionId: SHORT.id, answers: ["  rome. "] },
      NOW,
    );
    expect(res.result).toMatchObject({ isCorrect: true, pointsEarned: 100 });
  });

  it("refuse une réponse courte de plus de 200 caractères (400), comme en direct", async () => {
    await expect(
      service.answer(
        CODE,
        TOKEN,
        { questionId: SHORT.id, answers: ["x".repeat(201)] },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
