/**
 * Classeurs XLSX de test générés à la volée (issue #12) : aucune donnée
 * réelle, aucun fichier binaire versionné.
 */
import { Workbook } from "exceljs";

/** Classeur d'une feuille à partir d'un tableau de lignes (valeurs exceljs). */
export async function buildXlsx(
  rows: unknown[][],
  sheetName = "Feuille1",
): Promise<Buffer> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  rows.forEach((row, i) => {
    row.forEach((value, j) => {
      if (value !== undefined && value !== null && value !== "") {
        sheet.getCell(i + 1, j + 1).value = value as never;
      }
    });
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** En-têtes du modèle tableur Kahoot (à confirmer sur un vrai export). */
export const KAHOOT_HEADERS = [
  "",
  "Question - max 120 characters",
  "Answer 1 - max 75 characters",
  "Answer 2 - max 75 characters",
  "Answer 3 - max 75 characters",
  "Answer 4 - max 75 characters",
  "Time limit (sec) – 5, 10, 20, 30, 60, 90, 120, or 240 secs",
  "Correct answer(s) - choose at least one",
];

/**
 * Fixture anonymisée imitant le modèle tableur Kahoot : lignes de titre et
 * de consignes, ligne d'en-tête en ligne 8, puis les questions.
 */
export async function buildKahootFixture(
  questions: unknown[][] = [
    [1, "Capitale de l'Italie ?", "Rome", "Milan", "Turin", "Naples", 20, "1"],
    [2, "Nombres pairs ?", "2", "3", "4", "", 30, "1,3"],
    [3, "Le ciel est bleu.", "True", "False", "", "", 10, 1],
    [4, "Question sans bonne réponse", "Oui", "Non", "", "", 20, "5"],
  ],
): Promise<Buffer> {
  return buildXlsx(
    [
      ["", "Quiz template"],
      ["", "Add questions, at least two answer alternatives, time limit and choose correct answers (at least one). Have fun creating your awesome quiz!"],
      [],
      ["", "Remember: questions have a limit of 120 characters and answers can have 75 characters max."],
      [],
      [],
      [],
      KAHOOT_HEADERS,
      ...questions,
    ],
    "Sheet1",
  );
}
