/**
 * Lecture d'un fichier CSV d'import (issue #12), sans dépendance :
 *
 * - encodage UTF-8 (BOM facultatif, retiré) ; à défaut Windows-1252, encodage
 *   des CSV enregistrés par Excel en français ;
 * - séparateur détecté sur la première ligne : `;`, `,` ou tabulation (le
 *   plus fréquent hors guillemets, `;` en cas d'égalité) ;
 * - champs entre guillemets (RFC 4180) : séparateurs, guillemets doublés
 *   (`""`) et retours à la ligne autorisés à l'intérieur ;
 * - fins de ligne CRLF, LF ou CR.
 *
 * Le numéro de ligne renvoyé est celui de l'enregistrement (1 = en-tête),
 * comme le numéro de ligne affiché par un tableur. Les lignes vides sont
 * comptées mais pas renvoyées.
 */
import {
  ImportFileError,
  TabularRow,
  isBlankRow,
} from "./import.types";

const CANDIDATE_SEPARATORS = [";", ",", "\t"] as const;

/**
 * Caractères Windows-1252 des octets 0x80 à 0x9F (les autres octets valent
 * leur point de code Unicode, comme en ISO-8859-1). `TextDecoder` de Node
 * décode « windows-1252 » comme du latin-1 : table explicite.
 */
const CP1252_HIGH =
  "\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F" +
  "\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178";

export function decodeWindows1252(buffer: Buffer): string {
  let out = "";
  for (const byte of buffer) {
    out +=
      byte >= 0x80 && byte <= 0x9f
        ? CP1252_HIGH[byte - 0x80]
        : String.fromCharCode(byte);
  }
  return out;
}

/**
 * Décode le contenu brut d'un fichier texte. Refuse un fichier binaire
 * (octet nul, archive ZIP / XLSX, PDF) : le contenu n'est pas du type
 * annoncé.
 */
export function decodeTextFile(buffer: Buffer, label = "CSV"): string {
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x504b0304) {
    throw new ImportFileError(
      `Le fichier n'est pas un ${label} (archive ZIP / XLSX détectée)`,
      "unsupported_type",
    );
  }
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    throw new ImportFileError(
      `Le fichier n'est pas un ${label} (PDF détecté)`,
      "unsupported_type",
    );
  }
  if (buffer.includes(0)) {
    throw new ImportFileError(
      `Le fichier n'est pas un ${label} (contenu binaire)`,
      "unsupported_type",
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    text = decodeWindows1252(buffer);
  }
  return text.replace(/^\uFEFF/, "");
}

/** Séparateur le plus fréquent hors guillemets sur la première ligne. */
export function detectSeparator(text: string): string {
  const counts = new Map<string, number>(
    CANDIDATE_SEPARATORS.map((s) => [s, 0]),
  );
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === "\n" || char === "\r")) break;
    else if (!inQuotes && counts.has(char)) {
      counts.set(char, counts.get(char)! + 1);
    }
  }
  let best: string = ";";
  for (const sep of CANDIDATE_SEPARATORS) {
    if (counts.get(sep)! > counts.get(best)!) best = sep;
  }
  return best;
}

/**
 * Découpe un texte CSV en enregistrements. `maxRecords` borne le nombre
 * d'enregistrements non vides (en-tête compris) : au-delà, erreur.
 */
export function parseCsv(
  text: string,
  options: { separator?: string; maxRecords?: number } = {},
): TabularRow[] {
  const input = text.replace(/^\uFEFF/, "");
  const separator = options.separator ?? detectSeparator(input);
  const maxRecords = options.maxRecords ?? Infinity;

  const rows: TabularRow[] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  /** Le champ courant a commencé par un guillemet (et s'est refermé). */
  let quoted = false;
  let recordNumber = 1;
  let quoteStartRecord = 1;

  const endField = () => {
    record.push(quoted ? field : field.trim());
    field = "";
    quoted = false;
  };
  const endRecord = () => {
    endField();
    if (!isBlankRow(record)) {
      rows.push({ row: recordNumber, cells: record });
      if (rows.length > maxRecords) {
        throw new ImportFileError(
          `Trop de lignes : ${maxRecords - 1} lignes de données au plus`,
        );
      }
    }
    record = [];
    recordNumber++;
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.trim() === "" && !quoted) {
      // Guillemet ouvrant (espaces éventuels avant lui ignorés)
      field = "";
      inQuotes = true;
      quoted = true;
      quoteStartRecord = recordNumber;
    } else if (char === separator) {
      endField();
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      endRecord();
    } else if (quoted) {
      // Texte après le guillemet fermant : toléré s'il n'est fait que
      // d'espaces, sinon ajouté tel quel (comportement des tableurs).
      if (char.trim() !== "") field += char;
    } else {
      field += char;
    }
  }

  if (inQuotes) {
    throw new ImportFileError(
      `Ligne ${quoteStartRecord} : guillemet ouvrant sans guillemet fermant`,
    );
  }
  if (field !== "" || quoted || record.length > 0) endRecord();

  return rows;
}
