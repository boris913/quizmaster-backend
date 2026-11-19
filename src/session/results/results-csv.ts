/**
 * Export CSV des résultats d'une session (GET /api/sessions/:id/results.csv).
 *
 * Format pensé pour Excel / LibreOffice en français :
 * - séparateur `;`, fins de ligne CRLF (RFC 4180) ;
 * - UTF-8 précédé d'un BOM, sinon Excel lit les accents en Windows-1252 ;
 * - nombres décimaux avec une virgule.
 *
 * Une ligne par participant (rang, pseudo, score, précision, réponses,
 * timeouts, temps moyen) puis une colonne par question (options choisies et
 * verdict).
 */
import type { ResultsAnswerRow, SessionResults } from "./session-results";
import { isGradedQuestionType } from "./session-results";

export const CSV_SEPARATOR = ";";
export const CSV_BOM = "﻿";
const CSV_EOL = "\r\n";

/**
 * Échappe une cellule : entourée de guillemets si elle contient le
 * séparateur, un guillemet ou un saut de ligne ; les guillemets internes sont
 * doublés. Les cellules commençant par `=`, `+`, `-` ou `@` (texte libre :
 * pseudo, intitulé) sont préfixées d'une apostrophe pour éviter l'injection
 * de formules dans le tableur.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[";\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(rows: unknown[][]): string {
  return (
    CSV_BOM +
    rows
      .map((row) => row.map(escapeCsvCell).join(CSV_SEPARATOR))
      .join(CSV_EOL) +
    CSV_EOL
  );
}

/** Nombre au format français (virgule décimale), `decimals` chiffres max. */
function frNumber(value: number, decimals: number): string {
  const factor = 10 ** decimals;
  return String(Math.round(value * factor) / factor).replace(".", ",");
}

function answerCell(row: ResultsAnswerRow | undefined, graded: boolean) {
  if (!row) return "";
  if (row.status === "timeout") return "(temps écoulé)";
  if (row.status !== "answered") return `(${row.status})`;
  const choice = (row.answers ?? []).join(", ") || "-";
  if (!graded) return choice;
  return `${choice} (${row.is_correct ? "juste" : "faux"})`;
}

export function buildResultsCsv(
  results: SessionResults,
  answers: ResultsAnswerRow[],
): string {
  const questions = results.perQuestion;
  const byKey = new Map(
    answers.map((a) => [`${a.participant_id}|${a.question_id}`, a]),
  );

  const header = [
    "Rang",
    "Pseudo",
    "Score",
    "Précision (%)",
    "Réponses",
    "Sans réponse",
    "Temps moyen (s)",
    ...questions.map((q, i) => `Q${i + 1} - ${q.text}`),
  ];

  const lines = results.perParticipant.map((p, index) => [
    index + 1,
    p.pseudo,
    p.score,
    frNumber(p.accuracy * 100, 1),
    p.answered,
    p.timeouts,
    frNumber(p.avgTimeMs / 1000, 1),
    ...questions.map((q) =>
      answerCell(
        byKey.get(`${p.participantId}|${q.questionId}`),
        isGradedQuestionType(q.type),
      ),
    ),
  ]);

  return toCsv([header, ...lines]);
}

/** Nom de fichier ASCII sûr pour l'en-tête Content-Disposition. */
export function resultsCsvFilename(results: SessionResults): string {
  const slug =
    results.session.quizTitle
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "session";
  const date = (results.session.startedAt ?? "").slice(0, 10);
  return `resultats-${slug}${date ? `-${date}` : ""}.csv`;
}
