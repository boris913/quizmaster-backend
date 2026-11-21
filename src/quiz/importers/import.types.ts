/**
 * Types et limites communs aux imports de questions (issue #12).
 */

/** Formats acceptés par `POST /api/quizzes/:id/import?format=...`. */
export const IMPORT_FORMATS = ["markdown", "csv", "xlsx", "kahoot"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** Taille maximale d'un fichier importé : 2 Mo. */
export const IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Nombre maximal de lignes de données (questions) par import. */
export const IMPORT_MAX_ROWS = 200;

/**
 * Taille décompressée maximale d'un classeur XLSX (somme des entrées de
 * l'archive ZIP), contre les « bombes ZIP » : 20 Mo.
 */
export const XLSX_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;

/** Nombre maximal d'entrées dans l'archive ZIP d'un classeur XLSX. */
export const XLSX_MAX_ZIP_ENTRIES = 500;

/** Ligne d'un fichier tabulaire : numéro (1 = première ligne) et cellules. */
export interface TabularRow {
  row: number;
  cells: string[];
}

/** Erreur rattachée à une ligne du fichier (ou à un numéro de question). */
export interface ImportRowError {
  row: number;
  message: string;
}

/**
 * Question candidate extraite d'une ligne, avant validation par le DTO
 * `CreateQuestionDto` (objet brut, comme un corps JSON reçu par l'API).
 */
export interface ImportCandidate {
  row: number;
  question: Record<string, unknown>;
}

/** Résultat d'un parseur : candidates et erreurs de lecture par ligne. */
export interface ParsedImport {
  candidates: ImportCandidate[];
  errors: ImportRowError[];
}

/**
 * Erreur de fichier (et non de ligne) : type, structure ou taille. Convertie
 * en 400 / 413 / 415 par le service.
 */
export class ImportFileError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "too_large" | "unsupported_type" = "invalid",
  ) {
    super(message);
    this.name = "ImportFileError";
  }
}

/**
 * Clé de colonne normalisée : minuscules, sans accents, caractères non
 * alphanumériques remplacés par `_`. Ex. `"Bonnes réponses"` →
 * `"bonnes_reponses"`.
 */
export function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Vrai si toutes les cellules sont vides (après rognage). */
export function isBlankRow(cells: string[]): boolean {
  return cells.every((c) => c.trim() === "");
}
