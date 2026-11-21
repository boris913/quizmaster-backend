/**
 * Import tabulaire (CSV et XLSX, issue #12) : une question par ligne, avec
 * les colonnes du modèle `GET /api/quizzes/import-template.csv`.
 *
 * Colonnes (en-tête obligatoire en première ligne non vide, insensible à la
 * casse et aux accents ; ordre libre ; seule `question` est obligatoire) :
 *
 * | Colonne           | Alias acceptés                         |
 * |-------------------|----------------------------------------|
 * | `type`            |                                        |
 * | `question`        | `enonce`, `texte`, `text`              |
 * | `option_a`…`option_f` | `a`…`f`, `choix_a`…, `proposition_a`… |
 * | `bonnes_reponses` | `bonne_reponse`, `reponses`, `correct`, `correct_answers` |
 * | `points`          | `max_points`                           |
 * | `timer`           | `timer_seconds`, `temps`, `duree`      |
 * | `explication`     | `explanation`                          |
 * | `image_url`       | `image`                                |
 *
 * Sémantique de `bonnes_reponses` selon le type :
 * - `single` / `multiple` : lettres des bonnes options (`A`, `A,C`, `A|C`) ;
 * - `true_false` : `vrai` / `faux` (ou `true` / `false`), colonnes d'options
 *   vides ;
 * - `ordering` : vide = options dans l'ordre des colonnes, sinon lettres dans
 *   l'ordre attendu (`C,A,B`) ;
 * - `short_answer` : variantes acceptées séparées par `|`, options vides ;
 * - `poll` : vide.
 *
 * Type vide : `short_answer` si aucune option mais une réponse, `multiple`
 * si plusieurs lettres, sinon `single`. Points par défaut 100, timer 30 s.
 *
 * Le parseur ne fait que mettre en forme : la validation est celle de
 * `CreateQuestionDto` (appliquée par le service, comme pour
 * `POST /api/quizzes/:id/questions`).
 */
import {
  QUESTION_TYPES,
  QuestionType,
} from "../../common/utils/question-types.util";
import {
  ImportCandidate,
  ImportFileError,
  ImportRowError,
  ParsedImport,
  TabularRow,
  normalizeHeader,
} from "./import.types";

const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

type Field =
  | "type"
  | "text"
  | "correct"
  | "points"
  | "timer"
  | "explanation"
  | "image_url"
  | `option_${(typeof OPTION_LETTERS)[number]}`;

/** En-têtes du modèle CSV, dans l'ordre. */
export const TEMPLATE_HEADERS = [
  "type",
  "question",
  "option_a",
  "option_b",
  "option_c",
  "option_d",
  "option_e",
  "option_f",
  "bonnes_reponses",
  "points",
  "timer",
  "explication",
  "image_url",
] as const;

const HEADER_ALIASES: Record<string, Field> = {
  type: "type",
  question: "text",
  enonce: "text",
  texte: "text",
  text: "text",
  bonnes_reponses: "correct",
  bonne_reponse: "correct",
  reponses: "correct",
  reponse: "correct",
  correct: "correct",
  correct_answers: "correct",
  points: "points",
  max_points: "points",
  timer: "timer",
  timer_seconds: "timer",
  temps: "timer",
  duree: "timer",
  explication: "explanation",
  explanation: "explanation",
  image_url: "image_url",
  image: "image_url",
};
for (const letter of OPTION_LETTERS) {
  const l = letter.toLowerCase();
  for (const key of [`option_${l}`, l, `choix_${l}`, `proposition_${l}`]) {
    HEADER_ALIASES[key] = `option_${letter}`;
  }
}

/** Alias de type acceptés (en plus des noms officiels). */
const TYPE_ALIASES: Record<string, QuestionType> = {
  unique: "single",
  choix_unique: "single",
  qcm: "multiple",
  choix_multiple: "multiple",
  vrai_faux: "true_false",
  ordre: "ordering",
  remise_en_ordre: "ordering",
  reponse_courte: "short_answer",
  sondage: "poll",
};

const TRUE_VALUES = ["vrai", "true", "v", "oui", "yes", "1"];
const FALSE_VALUES = ["faux", "false", "f", "non", "no", "0"];

/** Ligne du modèle téléchargeable (exemples, un par type). */
export const TEMPLATE_EXAMPLES: string[][] = [
  [
    "single",
    "Quelle est la capitale de la France ?",
    "Lyon",
    "Paris",
    "Marseille",
    "",
    "",
    "",
    "B",
    "100",
    "30",
    "Paris est la capitale depuis le Xe siècle.",
    "",
  ],
  [
    "multiple",
    "Lesquels sont des nombres premiers ?",
    "2",
    "4",
    "7",
    "9",
    "",
    "",
    "A,C",
    "100",
    "30",
    "",
    "",
  ],
  [
    "true_false",
    "La Terre tourne autour du Soleil.",
    "",
    "",
    "",
    "",
    "",
    "",
    "vrai",
    "50",
    "20",
    "",
    "",
  ],
  [
    "ordering",
    "Classez du plus petit au plus grand.",
    "1",
    "10",
    "100",
    "1000",
    "",
    "",
    "",
    "100",
    "45",
    "Laisser bonnes_reponses vide = ordre des colonnes.",
    "",
  ],
  [
    "short_answer",
    "Quel est le symbole chimique de l'or ?",
    "",
    "",
    "",
    "",
    "",
    "",
    "Au|au",
    "100",
    "30",
    "",
    "",
  ],
  [
    "poll",
    "Quel format préférez-vous ?",
    "Quiz en direct",
    "Devoir",
    "Les deux",
    "",
    "",
    "",
    "",
    "100",
    "20",
    "",
    "",
  ],
];

/** Normalise un type saisi (casse, accents, espaces) ; null si inconnu. */
export function parseQuestionType(raw: string): QuestionType | null {
  const key = normalizeHeader(raw);
  if ((QUESTION_TYPES as readonly string[]).includes(key)) {
    return key as QuestionType;
  }
  return TYPE_ALIASES[key] ?? null;
}

/** Nombre saisi (virgule décimale acceptée) ; `undefined` si vide. */
export function parseNumberCell(raw: string): number | undefined | null {
  const value = raw.trim();
  if (!value) return undefined;
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Lettres d'options : `"a, c"`, `"A|C"`, `"A;C"` → `["A", "C"]`. */
export function parseLetters(raw: string): string[] {
  return raw
    .split(/[\s,;|]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/** Associe chaque colonne de l'en-tête à un champ (null = colonne vide). */
function mapHeader(header: TabularRow): (Field | null)[] {
  const fields: (Field | null)[] = [];
  const seen = new Set<Field>();
  header.cells.forEach((cell, index) => {
    if (!cell.trim()) {
      fields.push(null);
      return;
    }
    const field = HEADER_ALIASES[normalizeHeader(cell)];
    if (!field) {
      throw new ImportFileError(
        `Ligne ${header.row} : colonne inconnue "${cell.trim()}" (colonne ${index + 1}). Colonnes attendues : ${TEMPLATE_HEADERS.join(", ")}`,
      );
    }
    if (seen.has(field)) {
      throw new ImportFileError(
        `Ligne ${header.row} : colonne "${cell.trim()}" en double`,
      );
    }
    seen.add(field);
    fields.push(field);
  });
  if (!seen.has("text")) {
    throw new ImportFileError(
      `Ligne ${header.row} : colonne "question" manquante (en-tête attendu : ${TEMPLATE_HEADERS.join(", ")})`,
    );
  }
  return fields;
}

/**
 * Convertit les lignes (en-tête compris) en questions candidates. Les lignes
 * vides doivent déjà être retirées.
 */
export function parseTabularRows(rows: TabularRow[]): ParsedImport {
  if (rows.length === 0) {
    throw new ImportFileError("Fichier vide");
  }
  const [header, ...dataRows] = rows;
  const fields = mapHeader(header);
  const candidates: ImportCandidate[] = [];
  const errors: ImportRowError[] = [];

  for (const { row, cells } of dataRows) {
    const get = (field: Field): string => {
      const index = fields.indexOf(field);
      return index >= 0 ? (cells[index] ?? "").trim() : "";
    };
    const extra = cells
      .slice(fields.length)
      .some((c) => c.trim() !== "");
    const ignored = cells.some(
      (c, i) => fields[i] === null && c.trim() !== "",
    );
    if (extra || ignored) {
      errors.push({
        row,
        message: "valeur dans une colonne sans en-tête",
      });
      continue;
    }

    const options = OPTION_LETTERS.flatMap((letter) => {
      const text = get(`option_${letter}`);
      return text ? [{ id: letter, text }] : [];
    });
    const rawCorrect = get("correct");
    const rawType = get("type");

    let type: QuestionType | null;
    if (rawType) {
      type = parseQuestionType(rawType);
      if (!type) {
        errors.push({
          row,
          message: `type inconnu "${rawType}" (attendus : ${QUESTION_TYPES.join(", ")})`,
        });
        continue;
      }
    } else if (options.length === 0 && rawCorrect) {
      type = "short_answer";
    } else {
      type = parseLetters(rawCorrect).length > 1 ? "multiple" : "single";
    }

    let correct: string[];
    switch (type) {
      case "short_answer":
        correct = rawCorrect
          .split("|")
          .map((v) => v.trim())
          .filter(Boolean);
        break;
      case "true_false": {
        const value = normalizeHeader(rawCorrect);
        correct = TRUE_VALUES.includes(value)
          ? ["true"]
          : FALSE_VALUES.includes(value)
            ? ["false"]
            : rawCorrect
              ? [rawCorrect]
              : [];
        break;
      }
      case "ordering":
        correct = rawCorrect
          ? parseLetters(rawCorrect)
          : options.map((o) => o.id);
        break;
      default:
        correct = parseLetters(rawCorrect);
    }

    const points = parseNumberCell(get("points"));
    const timer = parseNumberCell(get("timer"));
    if (points === null || timer === null) {
      errors.push({
        row,
        message: `${points === null ? "points" : "timer"} : nombre attendu`,
      });
      continue;
    }

    const question: Record<string, unknown> = {
      text: get("text"),
      type,
      options,
      correct_answers: correct,
      max_points: points ?? 100,
      timer_seconds: timer ?? 30,
    };
    const explanation = get("explanation");
    if (explanation) question.explanation = explanation;
    const imageUrl = get("image_url");
    if (imageUrl) question.image_url = imageUrl;
    candidates.push({ row, question });
  }

  return { candidates, errors };
}
