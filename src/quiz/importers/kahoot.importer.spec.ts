import {
  KAHOOT_HEADERS,
  buildKahootFixture,
  buildXlsx,
} from "../../test-utils/xlsx-fixtures";
import { ImportFileError } from "./import.types";
import { parseKahootRows } from "./kahoot.importer";
import { readXlsxRows } from "./xlsx.reader";

/**
 * Fixture générée (modèle tableur Kahoot supposé) : le format doit être
 * confirmé sur un vrai export avant d'être considéré comme fiable.
 */
describe("parseKahootRows (issue #12, fixture anonymisée)", () => {
  it("trouve l'en-tête sous les lignes de titre et convertit les questions", async () => {
    const rows = await readXlsxRows(await buildKahootFixture());
    const { candidates, errors } = parseKahootRows(rows);

    expect(candidates.map((c) => c.row)).toEqual([9, 10, 11]);
    expect(candidates[0].question).toEqual({
      text: "Capitale de l'Italie ?",
      type: "single",
      options: [
        { id: "A", text: "Rome" },
        { id: "B", text: "Milan" },
        { id: "C", text: "Turin" },
        { id: "D", text: "Naples" },
      ],
      correct_answers: ["A"],
      max_points: 100,
      timer_seconds: 20,
    });
    expect(candidates[1].question).toMatchObject({
      type: "multiple",
      options: [
        { id: "A", text: "2" },
        { id: "B", text: "3" },
        { id: "C", text: "4" },
      ],
      correct_answers: ["A", "C"],
      timer_seconds: 30,
    });
    // Vrai / faux Kahoot : question à choix unique à 2 options
    expect(candidates[2].question).toMatchObject({
      type: "single",
      correct_answers: ["A"],
      timer_seconds: 10,
    });
    expect(errors).toEqual([
      { row: 12, message: expect.stringContaining('"5"') },
    ]);
  });

  it("timer vide → 30 s ; time limit non numérique → erreur de ligne", async () => {
    const rows = await readXlsxRows(
      await buildKahootFixture([
        [1, "Q1", "a", "b", "", "", "", "2"],
        [2, "Q2", "a", "b", "", "", "longtemps", "1"],
      ]),
    );
    const { candidates, errors } = parseKahootRows(rows);
    expect(candidates[0].question).toMatchObject({
      timer_seconds: 30,
      correct_answers: ["B"],
    });
    expect(errors).toEqual([{ row: 10, message: "time limit : nombre attendu" }]);
  });

  it("refuse un classeur sans en-tête Kahoot", async () => {
    const rows = await readXlsxRows(
      await buildXlsx([["question", "option_a"], ["Q", "x"]]),
    );
    expect(() => parseKahootRows(rows)).toThrow(/Format Kahoot non reconnu/);
  });

  it("borne le nombre de questions après l'en-tête", async () => {
    const rows = await readXlsxRows(
      await buildXlsx([
        KAHOOT_HEADERS,
        [1, "Q1", "a", "b", "", "", 20, "1"],
        [2, "Q2", "a", "b", "", "", 20, "1"],
      ]),
    );
    expect(() => parseKahootRows(rows, 1)).toThrow(ImportFileError);
    expect(parseKahootRows(rows, 2).candidates).toHaveLength(2);
  });
});
