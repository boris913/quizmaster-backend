/**
 * Import d'un tableur Kahoot (issue #12).
 *
 * FORMAT À CONFIRMER SUR UN VRAI EXPORT : aucun fichier réel n'était
 * disponible pendant le développement. Le parseur suit la disposition du
 * modèle tableur de questions Kahoot (« Quiz spreadsheet template ») :
 *
 * - quelques lignes de titre / consignes en haut de la feuille (ignorées) ;
 * - une ligne d'en-tête, cherchée dans les 30 premières lignes, contenant :
 *   `Question - max 120 characters`, `Answer 1 - max 75 characters` …
 *   `Answer 4 - max 75 characters`, `Time limit (sec) – 5, 10, 20, 30, 60,
 *   90, 120, or 240 secs`, `Correct answer(s) - choose at least one` ;
 *   une première colonne de numérotation (sans en-tête) est tolérée ;
 * - puis une question par ligne ; `Correct answer(s)` contient les numéros
 *   des bonnes réponses (`1`, `2,4`).
 *
 * Les colonnes sont reconnues par leur préfixe (`question`, `answer N`,
 * `time limit`, `correct answer`), insensible à la casse. Jusqu'à 6
 * réponses sont lues ; au-delà de 4, la validation des questions à choix
 * (A-D) refuse la ligne.
 *
 * Conversion : réponses 1-4 → options A-D ; type `multiple` si plusieurs
 * bonnes réponses, sinon `single` ; points 100 (le barème Kahoot n'est pas
 * dans le tableur) ; timer = time limit (30 s si vide). Les questions vrai /
 * faux Kahoot restent des questions `single` à 2 options.
 */
import {
  IMPORT_MAX_ROWS,
  ImportCandidate,
  ImportFileError,
  ImportRowError,
  ParsedImport,
  TabularRow,
  normalizeHeader,
} from "./import.types";
import { parseNumberCell } from "./tabular.importer";

/** Nombre de lignes parcourues pour trouver l'en-tête Kahoot. */
export const KAHOOT_HEADER_SEARCH_ROWS = 30;

const OPTION_IDS = ["A", "B", "C", "D", "E", "F"];

interface KahootColumns {
  question: number;
  answers: number[];
  timeLimit: number;
  correct: number;
}

/** Repère les colonnes Kahoot dans une ligne, ou null si ce n'est pas l'en-tête. */
function matchHeader(cells: string[]): KahootColumns | null {
  let question = -1;
  let timeLimit = -1;
  let correct = -1;
  const answers: number[] = [];
  cells.forEach((cell, index) => {
    const key = normalizeHeader(cell);
    const answer = key.match(/^answer_([1-6])(?:_|$)/);
    if (key.startsWith("question") && question < 0) question = index;
    else if (answer) answers[Number(answer[1]) - 1] = index;
    else if (key.startsWith("time_limit")) timeLimit = index;
    else if (key.startsWith("correct_answer")) correct = index;
  });
  if (question < 0 || correct < 0 || answers[0] === undefined) return null;
  // Réponses consécutives à partir de 1
  const consecutive: number[] = [];
  for (const col of answers) {
    if (col === undefined) break;
    consecutive.push(col);
  }
  return { question, answers: consecutive, timeLimit, correct };
}

/**
 * Convertit les lignes non vides de la feuille Kahoot en questions
 * candidates (validées ensuite comme `POST /api/quizzes/:id/questions`).
 */
export function parseKahootRows(
  rows: TabularRow[],
  maxDataRows = IMPORT_MAX_ROWS,
): ParsedImport {
  let headerIndex = -1;
  let columns: KahootColumns | null = null;
  for (
    let i = 0;
    i < rows.length && rows[i].row <= KAHOOT_HEADER_SEARCH_ROWS;
    i++
  ) {
    columns = matchHeader(rows[i].cells);
    if (columns) {
      headerIndex = i;
      break;
    }
  }
  if (!columns) {
    throw new ImportFileError(
      'Format Kahoot non reconnu : en-tête "Question", "Answer 1"…, "Correct answer(s)" introuvable dans les 30 premières lignes',
    );
  }

  const dataRows = rows.slice(headerIndex + 1);
  if (dataRows.length > maxDataRows) {
    throw new ImportFileError(
      `Trop de lignes : ${maxDataRows} lignes de données au plus`,
    );
  }

  const candidates: ImportCandidate[] = [];
  const errors: ImportRowError[] = [];
  for (const { row, cells } of dataRows) {
    const cell = (index: number) =>
      index >= 0 ? (cells[index] ?? "").trim() : "";
    const options = columns.answers.flatMap((col, i) => {
      const text = cell(col);
      return text ? [{ id: OPTION_IDS[i], text }] : [];
    });

    const rawCorrect = cell(columns.correct);
    const numbers = rawCorrect
      .split(/[\s,;|]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const invalid = numbers.filter(
      (n) => !/^[1-6]$/.test(n) || Number(n) > columns!.answers.length,
    );
    if (invalid.length > 0) {
      errors.push({
        row,
        message: `bonne(s) réponse(s) invalide(s) "${rawCorrect}" : numéros de réponse attendus (1 à ${columns.answers.length})`,
      });
      continue;
    }
    const correct = [...new Set(numbers)].map((n) => OPTION_IDS[Number(n) - 1]);

    const timer = parseNumberCell(cell(columns.timeLimit));
    if (timer === null) {
      errors.push({ row, message: "time limit : nombre attendu" });
      continue;
    }

    candidates.push({
      row,
      question: {
        text: cell(columns.question),
        type: correct.length > 1 ? "multiple" : "single",
        options,
        correct_answers: correct,
        max_points: 100,
        timer_seconds: timer ?? 30,
      },
    });
  }
  return { candidates, errors };
}
