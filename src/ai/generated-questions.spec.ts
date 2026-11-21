import "reflect-metadata";
import {
  MalformedAiOutputError,
  parseAndValidateQuestions,
  validateGeneratedQuestion,
} from "./generated-questions";
import { GENERATABLE_QUESTION_TYPES } from "./ai.constants";

const ALL = GENERATABLE_QUESTION_TYPES;

const single = (text = "Capitale de la France ?") => ({
  text,
  type: "single",
  options: [
    { id: "A", text: "Paris" },
    { id: "B", text: "Lyon" },
    { id: "C", text: "Marseille" },
  ],
  correct_answers: ["A"],
  explanation: "Paris est la capitale.",
});

const output = (questions: unknown[]) => JSON.stringify({ questions });

describe("parseAndValidateQuestions (issue #11)", () => {
  it("rejette un JSON malformé", async () => {
    await expect(
      parseAndValidateQuestions('{"questions": [', ALL, 5),
    ).rejects.toBeInstanceOf(MalformedAiOutputError);
  });

  it("rejette une sortie sans tableau questions", async () => {
    await expect(
      parseAndValidateQuestions('{"items": []}', ALL, 5),
    ).rejects.toBeInstanceOf(MalformedAiOutputError);
    await expect(
      parseAndValidateQuestions('{"questions": "non"}', ALL, 5),
    ).rejects.toBeInstanceOf(MalformedAiOutputError);
    await expect(
      parseAndValidateQuestions("null", ALL, 5),
    ).rejects.toBeInstanceOf(MalformedAiOutputError);
  });

  it("garde les questions valides de chaque type et ajoute max_points / timer", async () => {
    const result = await parseAndValidateQuestions(
      output([
        single(),
        {
          text: "Choisir les nombres pairs",
          type: "multiple",
          options: [
            { id: "A", text: "2" },
            { id: "B", text: "3" },
            { id: "C", text: "4" },
          ],
          correct_answers: ["A", "C"],
          explanation: "",
        },
        {
          text: "La Terre tourne autour du Soleil.",
          type: "true_false",
          options: [],
          correct_answers: ["true"],
          explanation: "Héliocentrisme.",
        },
        {
          text: "Ranger par ordre chronologique",
          type: "ordering",
          options: [
            { id: "A", text: "1789" },
            { id: "B", text: "1515" },
            { id: "C", text: "1914" },
          ],
          correct_answers: ["B", "A", "C"],
          explanation: "Ordre des dates.",
        },
        {
          text: "Symbole chimique de l'eau ?",
          type: "short_answer",
          options: [],
          correct_answers: ["H2O", "H₂O"],
          explanation: "Deux hydrogènes, un oxygène.",
        },
      ]),
      ALL,
      10,
    );
    expect(result.generated).toBe(5);
    expect(result.rejected).toBe(0);
    expect(result.questions).toHaveLength(5);
    expect(result.questions[0]).toMatchObject({
      type: "single",
      max_points: 100,
      timer_seconds: 30,
    });
  });

  it.each([
    [
      "single avec 2 bonnes réponses",
      { ...single(), correct_answers: ["A", "B"] },
    ],
    [
      "bonne réponse absente des options",
      { ...single(), correct_answers: ["D"] },
    ],
    [
      "true_false avec une réponse hors true/false",
      {
        text: "Vrai ?",
        type: "true_false",
        options: [],
        correct_answers: ["vrai"],
        explanation: "",
      },
    ],
    [
      "ordering dont correct_answers n'est pas une permutation",
      {
        text: "Ordonner",
        type: "ordering",
        options: [
          { id: "A", text: "a" },
          { id: "B", text: "b" },
          { id: "C", text: "c" },
        ],
        correct_answers: ["A", "B"],
        explanation: "",
      },
    ],
    [
      "short_answer sans variante",
      {
        text: "Réponse ?",
        type: "short_answer",
        options: [],
        correct_answers: [],
        explanation: "",
      },
    ],
    ["énoncé vide", { ...single(""), text: "" }],
    [
      "explication > 500 caractères",
      { ...single(), explanation: "x".repeat(501) },
    ],
    [
      "champ inconnu (forbidNonWhitelisted)",
      { ...single(), difficulty: "facile" },
    ],
    [
      "option id hors A-D pour single",
      {
        ...single(),
        options: [
          { id: "A", text: "a" },
          { id: "E", text: "e" },
        ],
      },
    ],
  ])("écarte une question incohérente : %s", async (_label, bad) => {
    const result = await parseAndValidateQuestions(
      output([single("Q valide"), bad]),
      ALL,
      10,
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].text).toBe("Q valide");
    expect(result.generated).toBe(2);
    expect(result.rejected).toBe(1);
  });

  it("écarte les types non demandés, les doublons, les non-objets et le surplus", async () => {
    const tf = {
      text: "Affirmation",
      type: "true_false",
      options: [],
      correct_answers: ["false"],
      explanation: "",
    };
    const result = await parseAndValidateQuestions(
      output([
        single("Q1"),
        tf, // type non demandé
        single("q1 "), // doublon (casse / espaces)
        "texte",
        null,
        single("Q2"),
        single("Q3"), // surplus (count = 2)
      ]),
      ["single"],
      2,
    );
    expect(result.questions.map((q) => q.text)).toEqual(["Q1", "Q2"]);
    expect(result.generated).toBe(7);
    expect(result.rejected).toBe(5);
  });

  it("valide avec le même DTO que POST /api/quizzes/:id/questions", async () => {
    const ok = await validateGeneratedQuestion(single());
    expect(ok.errors).toEqual([]);
    const ko = await validateGeneratedQuestion({ ...single(), max_points: 5 });
    expect(ko.question).toBeUndefined();
    expect(ko.errors.length).toBeGreaterThan(0);
  });
});
