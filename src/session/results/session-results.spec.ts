import {
  buildSessionResults,
  ResultsAnswerRow,
  ResultsParticipantRow,
  ResultsQuestionRow,
} from "./session-results";

const session = {
  id: "s1",
  status: "finished",
  started_at: "2026-11-19T09:00:00.000Z",
  ended_at: "2026-11-19T09:10:00.000Z",
  quizzes: { title: "Géographie" },
};

const options = [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }];

const q1: ResultsQuestionRow = {
  id: "q1",
  order_index: 0,
  text: "Capitale de la France ?",
  type: "single",
  options,
  correct_answers: ["B"],
};
const q2: ResultsQuestionRow = {
  id: "q2",
  order_index: 1,
  text: "Pays d'Europe ?",
  type: "multiple",
  options,
  correct_answers: ["A", "C"],
};

const alice: ResultsParticipantRow = { id: "p1", pseudo: "Alice", score: 250 };
const bob: ResultsParticipantRow = { id: "p2", pseudo: "Bob", score: 50 };
const chloe: ResultsParticipantRow = { id: "p3", pseudo: "Chloé", score: 0 };

function answer(
  participant_id: string,
  question_id: string,
  answers: string[],
  is_correct: boolean,
  time_taken_ms: number | null = 1000,
): ResultsAnswerRow {
  return {
    participant_id,
    question_id,
    answers,
    status: "answered",
    is_correct,
    time_taken_ms,
  };
}

function timeout(
  participant_id: string,
  question_id: string,
): ResultsAnswerRow {
  return {
    participant_id,
    question_id,
    answers: [],
    status: "timeout",
    is_correct: false,
    time_taken_ms: null,
  };
}

describe("buildSessionResults", () => {
  it("décrit la session selon le contrat", () => {
    const results = buildSessionResults({
      session,
      questions: [q1],
      participants: [alice, bob],
      answers: [],
    });

    expect(results.session).toEqual({
      id: "s1",
      quizTitle: "Géographie",
      status: "finished",
      startedAt: "2026-11-19T09:00:00.000Z",
      endedAt: "2026-11-19T09:10:00.000Z",
      participantCount: 2,
    });
  });

  it("gère une session sans aucune réponse (zéros, pas de NaN)", () => {
    const results = buildSessionResults({
      session,
      questions: [q1, q2],
      participants: [alice, bob],
      answers: [],
    });

    expect(results.summary).toEqual({
      accuracy: 0,
      avgScore: 150,
      completionRate: 0,
    });
    expect(results.perQuestion[0]).toEqual({
      questionId: "q1",
      orderIndex: 0,
      text: "Capitale de la France ?",
      type: "single",
      accuracy: 0,
      avgTimeMs: 0,
      answerDistribution: { A: 0, B: 0, C: 0, D: 0 },
      correctAnswers: ["B"],
    });
    expect(results.perParticipant[0]).toEqual({
      participantId: "p1",
      pseudo: "Alice",
      score: 250,
      accuracy: 0,
      answered: 0,
      timeouts: 0,
      avgTimeMs: 0,
    });
  });

  it("gère une session sans participant ni question", () => {
    const results = buildSessionResults({
      session: { ...session, quizzes: null, started_at: null, ended_at: null },
      questions: [],
      participants: [],
      answers: [],
    });

    expect(results.session.quizTitle).toBe("");
    expect(results.session.participantCount).toBe(0);
    expect(results.summary).toEqual({
      accuracy: 0,
      avgScore: 0,
      completionRate: 0,
    });
    expect(results.perQuestion).toEqual([]);
    expect(results.perParticipant).toEqual([]);
  });

  it("compte les timeouts comme faux et les exclut des temps moyens", () => {
    const results = buildSessionResults({
      session,
      questions: [q1],
      participants: [alice, bob],
      answers: [answer("p1", "q1", ["B"], true, 3000), timeout("p2", "q1")],
    });

    expect(results.perQuestion[0].accuracy).toBe(0.5);
    expect(results.perQuestion[0].avgTimeMs).toBe(3000);
    expect(results.perQuestion[0].answerDistribution).toEqual({
      A: 0,
      B: 1,
      C: 0,
      D: 0,
    });
    expect(results.summary.accuracy).toBe(0.5);
    expect(results.summary.completionRate).toBe(0.5);

    const bobResult = results.perParticipant.find(
      (p) => p.participantId === "p2",
    );
    expect(bobResult).toMatchObject({
      accuracy: 0,
      answered: 0,
      timeouts: 1,
      avgTimeMs: 0,
    });
  });

  it("compte chaque option cochée d'une question à choix multiple", () => {
    const results = buildSessionResults({
      session,
      questions: [q2],
      participants: [alice, bob, chloe],
      answers: [
        answer("p1", "q2", ["A", "C"], true),
        answer("p2", "q2", ["A", "B"], false),
        // Doublon défensif : une option n'est comptée qu'une fois par réponse
        answer("p3", "q2", ["C", "C"], false),
      ],
    });

    const q = results.perQuestion[0];
    expect(q.answerDistribution).toEqual({ A: 2, B: 1, C: 2, D: 0 });
    expect(q.correctAnswers).toEqual(["A", "C"]);
    expect(q.accuracy).toBe(0.3333);
    expect(q.type).toBe("multiple");
  });

  it("agrège par participant (précision, réponses, temps moyen)", () => {
    const results = buildSessionResults({
      session,
      questions: [q2, q1], // non triées : l'ordre suit order_index
      participants: [alice, bob, chloe],
      answers: [
        answer("p1", "q1", ["B"], true, 1000),
        answer("p1", "q2", ["A", "C"], true, 2001),
        answer("p2", "q1", ["A"], false, 4000),
        timeout("p2", "q2"),
        // Chloé (p3) n'a aucune ligne : arrivée après la partie
      ],
    });

    expect(results.perQuestion.map((q) => q.questionId)).toEqual(["q1", "q2"]);
    expect(results.perParticipant).toEqual([
      {
        participantId: "p1",
        pseudo: "Alice",
        score: 250,
        accuracy: 1,
        answered: 2,
        timeouts: 0,
        avgTimeMs: 1501,
      },
      {
        participantId: "p2",
        pseudo: "Bob",
        score: 50,
        accuracy: 0,
        answered: 1,
        timeouts: 1,
        avgTimeMs: 4000,
      },
      {
        participantId: "p3",
        pseudo: "Chloé",
        score: 0,
        accuracy: 0,
        answered: 0,
        timeouts: 0,
        avgTimeMs: 0,
      },
    ]);
    // 2 bonnes réponses sur 4 lignes
    expect(results.summary.accuracy).toBe(0.5);
    // 3 réponses sur 3 participants × 2 questions jouées
    expect(results.summary.completionRate).toBe(0.5);
    expect(results.summary.avgScore).toBe(100);
  });

  it("n'inclut pas les questions non jouées dans le taux de complétion", () => {
    const results = buildSessionResults({
      session,
      questions: [q1, q2],
      participants: [alice],
      answers: [answer("p1", "q1", ["B"], true)],
    });

    expect(results.summary.completionRate).toBe(1);
    expect(results.perQuestion[1].accuracy).toBe(0);
  });

  it("exclut les questions de type poll de toutes les précisions", () => {
    const poll: ResultsQuestionRow = {
      id: "q3",
      order_index: 2,
      text: "Avez-vous aimé ?",
      type: "poll",
      options: [{ id: "A" }, { id: "B" }],
      correct_answers: [],
    };
    const results = buildSessionResults({
      session,
      questions: [q1, poll],
      participants: [alice],
      answers: [
        answer("p1", "q1", ["B"], true),
        // is_correct à false sur un sondage : ne doit pas faire baisser la précision
        answer("p1", "q3", ["A"], false),
      ],
    });

    expect(results.summary.accuracy).toBe(1);
    expect(results.perParticipant[0].accuracy).toBe(1);
    expect(results.perParticipant[0].answered).toBe(2);
    expect(results.perQuestion[1].accuracy).toBe(0);
    expect(results.perQuestion[1].answerDistribution).toEqual({ A: 1, B: 0 });
    expect(results.summary.completionRate).toBe(1);
  });

  it("ignore les réponses d'une question ou d'un participant inconnus", () => {
    const results = buildSessionResults({
      session,
      questions: [q1],
      participants: [alice],
      answers: [
        answer("p1", "q1", ["B"], true),
        answer("p1", "q-supprimee", ["A"], false),
        answer("intrus", "q1", ["A"], false),
      ],
    });

    expect(results.summary.accuracy).toBe(1);
    expect(results.perQuestion[0].answerDistribution.A).toBe(0);
    expect(results.summary.completionRate).toBe(1);
  });
});
