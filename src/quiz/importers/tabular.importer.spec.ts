import { ImportFileError, TabularRow } from "./import.types";
import {
  TEMPLATE_EXAMPLES,
  TEMPLATE_HEADERS,
  parseQuestionType,
  parseTabularRows,
} from "./tabular.importer";

const table = (...rows: string[][]): TabularRow[] =>
  rows.map((cells, i) => ({ row: i + 1, cells }));

describe("parseTabularRows (issue #12)", () => {
  it("convertit chaque exemple du modèle en question candidate", () => {
    const { candidates, errors } = parseTabularRows(
      table([...TEMPLATE_HEADERS], ...TEMPLATE_EXAMPLES),
    );
    expect(errors).toEqual([]);
    expect(candidates.map((c) => c.question.type)).toEqual([
      "single",
      "multiple",
      "true_false",
      "ordering",
      "short_answer",
      "poll",
    ]);
    const [single, multiple, tf, ordering, short, poll] = candidates.map(
      (c) => c.question,
    );
    expect(single).toMatchObject({
      text: "Quelle est la capitale de la France ?",
      options: [
        { id: "A", text: "Lyon" },
        { id: "B", text: "Paris" },
        { id: "C", text: "Marseille" },
      ],
      correct_answers: ["B"],
      max_points: 100,
      timer_seconds: 30,
      explanation: "Paris est la capitale depuis le Xe siècle.",
    });
    expect(multiple.correct_answers).toEqual(["A", "C"]);
    expect(tf).toMatchObject({ options: [], correct_answers: ["true"] });
    expect(ordering.correct_answers).toEqual(["A", "B", "C", "D"]);
    expect(short).toMatchObject({ options: [], correct_answers: ["Au", "au"] });
    expect(poll.correct_answers).toEqual([]);
    expect(candidates.map((c) => c.row)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("accepte des en-têtes en français, accentués, dans le désordre", () => {
    const { candidates } = parseTabularRows(
      table(
        ["Énoncé", "Bonnes réponses", "A", "B", "Temps", "Points"],
        ["Q ?", "b", "x", "y", "20", "50,0"],
      ),
    );
    expect(candidates[0].question).toMatchObject({
      text: "Q ?",
      type: "single",
      correct_answers: ["B"],
      timer_seconds: 20,
      max_points: 50,
    });
  });

  it("déduit le type quand la colonne est vide", () => {
    const { candidates } = parseTabularRows(
      table(
        ["question", "option_a", "option_b", "bonnes_reponses"],
        ["Q1", "x", "y", "A|B"],
        ["Q2", "", "", "Paris|Paname"],
        ["Q3", "x", "y", "A"],
      ),
    );
    expect(candidates.map((c) => c.question.type)).toEqual([
      "multiple",
      "short_answer",
      "single",
    ]);
  });

  it("ordering : ordre explicite dans bonnes_reponses", () => {
    const { candidates } = parseTabularRows(
      table(
        ["type", "question", "a", "b", "c", "bonnes_reponses"],
        ["ordre", "Q", "x", "y", "z", "C, A, B"],
      ),
    );
    expect(candidates[0].question).toMatchObject({
      type: "ordering",
      correct_answers: ["C", "A", "B"],
    });
  });

  it("signale par ligne type inconnu, nombre invalide et cellule hors colonne", () => {
    const { candidates, errors } = parseTabularRows(
      table(
        ["type", "question", "points"],
        ["essay", "Q1", ""],
        ["single", "Q2", "beaucoup"],
        ["single", "Q3", "100", "en trop"],
      ),
    );
    expect(candidates).toEqual([]);
    expect(errors).toEqual([
      { row: 2, message: expect.stringContaining('type inconnu "essay"') },
      { row: 3, message: "points : nombre attendu" },
      { row: 4, message: "valeur dans une colonne sans en-tête" },
    ]);
  });

  it("refuse un en-tête sans colonne question, avec colonne inconnue ou en double", () => {
    expect(() => parseTabularRows(table(["type", "option_a"]))).toThrow(
      /colonne "question" manquante/,
    );
    expect(() => parseTabularRows(table(["question", "explicaton"]))).toThrow(
      /colonne inconnue "explicaton"/,
    );
    expect(() => parseTabularRows(table(["question", "texte"]))).toThrow(
      /en double/,
    );
    expect(() => parseTabularRows([])).toThrow(ImportFileError);
  });

  it("normalise les alias de type", () => {
    expect(parseQuestionType("Vrai-Faux")).toBe("true_false");
    expect(parseQuestionType("Réponse courte")).toBe("short_answer");
    expect(parseQuestionType("SONDAGE")).toBe("poll");
    expect(parseQuestionType("essay")).toBeNull();
  });
});
