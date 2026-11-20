import { Test } from "@nestjs/testing";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SUPABASE_CLIENT } from "../database/database.module";
import { createSupabaseMock, SupabaseMock } from "../test-utils/supabase.mock";
import { CreateSessionDto } from "./dto/session.dto";
import { SessionService } from "./session.service";

const OWNER = "user-owner";

async function validateCreate(plain: Record<string, unknown>) {
  const dto = plainToInstance(CreateSessionDto, plain);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe("CreateSessionDto : scoringMode et showLeaderboard (issue #8)", () => {
  it("accepte les deux réglages, ou leur absence", async () => {
    expect(await validateCreate({ quiz_id: "q" })).toEqual([]);
    expect(
      await validateCreate({
        quiz_id: "q",
        scoringMode: "accuracy",
        showLeaderboard: false,
      }),
    ).toEqual([]);
    expect(
      await validateCreate({
        quiz_id: "q",
        scoringMode: "speed",
        showLeaderboard: true,
      }),
    ).toEqual([]);
  });

  it("refuse un mode de score inconnu", async () => {
    expect(
      await validateCreate({ quiz_id: "q", scoringMode: "turbo" }),
    ).toContain("scoringMode");
  });

  it("refuse un showLeaderboard non booléen", async () => {
    expect(
      await validateCreate({ quiz_id: "q", showLeaderboard: "false" }),
    ).toContain("showLeaderboard");
  });
});

describe("SessionService.createSession : réglages persistés (issue #8)", () => {
  let service: SessionService;
  let supabase: SupabaseMock;

  const quiz = {
    id: "quiz1",
    creator_id: OWNER,
    total_questions: 3,
    title: "Mon quiz",
  };
  const conflict = {
    code: "23505",
    message:
      'duplicate key value violates unique constraint "sessions_password_key"',
    details: "Key (password)=(ABC234) already exists.",
  };
  const inserted = () =>
    supabase
      .queriesFor("sessions")
      .map(
        (q) =>
          q.calls.find((c) => c.method === "insert")?.args[0] as Record<
            string,
            unknown
          >,
      );

  beforeEach(async () => {
    supabase = createSupabaseMock();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: SUPABASE_CLIENT, useValue: supabase.client },
      ],
    }).compile();
    service = moduleRef.get(SessionService);
  });

  it("valeurs par défaut : speed et classement visible", async () => {
    supabase
      .mockResponse("quizzes", { data: quiz })
      .mockResponse("sessions", { data: { id: "s1" } });

    await service.createSession(OWNER, { quiz_id: "quiz1" });

    expect(inserted()[0]).toMatchObject({
      scoring_mode: "speed",
      show_leaderboard: true,
      nickname_mode: "free",
    });
  });

  it("enregistre accuracy et classement masqué", async () => {
    supabase.mockResponse("quizzes", { data: quiz }).mockResponse("sessions", {
      data: { id: "s1", scoring_mode: "accuracy", show_leaderboard: false },
    });

    const created = await service.createSession(OWNER, {
      quiz_id: "quiz1",
      scoringMode: "accuracy",
      showLeaderboard: false,
    });

    expect(inserted()[0]).toMatchObject({
      scoring_mode: "accuracy",
      show_leaderboard: false,
    });
    expect(created).toMatchObject({
      scoring_mode: "accuracy",
      show_leaderboard: false,
    });
  });

  it("conserve les réglages à chaque nouveau tirage du code", async () => {
    supabase
      .mockResponse("quizzes", { data: quiz })
      .mockResponse("sessions", { error: conflict })
      .mockResponse("sessions", { data: { id: "s1" } });

    await service.createSession(OWNER, {
      quiz_id: "quiz1",
      nicknameMode: "generated",
      scoringMode: "accuracy",
      showLeaderboard: false,
    });

    const inserts = inserted();
    expect(inserts).toHaveLength(2);
    for (const row of inserts) {
      expect(row).toMatchObject({
        nickname_mode: "generated",
        scoring_mode: "accuracy",
        show_leaderboard: false,
      });
    }
  });

  it("joinSession renvoie les réglages au joueur", async () => {
    supabase.mockResponse("sessions", {
      data: {
        id: "s1",
        status: "waiting",
        quiz_id: "quiz1",
        scoring_mode: "accuracy",
        show_leaderboard: false,
      },
    });
    // assertNicknameAcceptable, unicité du pseudo, création
    supabase
      .mockResponse("sessions", { data: { nickname_mode: "free" } })
      .mockResponse("participants", { data: [] })
      .mockResponse("participants", { data: null })
      .mockResponse("participants", { data: { id: "p1", pseudo: "Alice" } });

    const { session } = await service.joinSession({
      password: "ABC234",
      pseudo: "Alice",
    });

    const select = supabase
      .queriesFor("sessions")[0]
      .calls.find((c) => c.method === "select");
    expect(String(select?.args[0])).toMatch(/scoring_mode.*show_leaderboard/);
    expect(session).toMatchObject({
      scoring_mode: "accuracy",
      show_leaderboard: false,
    });
  });
});
