/**
 * Lecture de la première feuille d'un classeur XLSX (issue #12) avec
 * `exceljs`.
 *
 * Sécurité :
 * - le contenu doit être une archive ZIP (signature `PK\x03\x04`), sinon le
 *   fichier n'est pas du type annoncé ;
 * - avant toute décompression, le répertoire central de l'archive est lu
 *   pour borner le nombre d'entrées et la taille décompressée totale
 *   (« bombe ZIP ») ; le ZIP64 est refusé ;
 * - les formules ne sont jamais évaluées : seule la dernière valeur calculée
 *   enregistrée dans le fichier est lue (vide si absente).
 */
import { Workbook, CellValue } from "exceljs";
import {
  ImportFileError,
  TabularRow,
  XLSX_MAX_UNCOMPRESSED_BYTES,
  XLSX_MAX_ZIP_ENTRIES,
  isBlankRow,
} from "./import.types";

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIR = 0x06054b50;

/** Vrai si le contenu commence par la signature d'une archive ZIP. */
export function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === ZIP_LOCAL_HEADER;
}

/**
 * Vérifie l'archive ZIP sans la décompresser : nombre d'entrées et somme
 * des tailles décompressées déclarées par le répertoire central.
 */
export function assertSafeZip(buffer: Buffer): void {
  if (!isZip(buffer)) {
    throw new ImportFileError(
      "Le fichier n'est pas un classeur XLSX",
      "unsupported_type",
    );
  }
  // Fin du répertoire central : 22 octets + commentaire (≤ 65 535 octets)
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === ZIP_END_OF_CENTRAL_DIR) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new ImportFileError("Classeur XLSX illisible (archive incomplète)");
  }
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || centralOffset === 0xffffffff) {
    throw new ImportFileError("Classeur XLSX refusé (archive ZIP64)");
  }
  if (entries > XLSX_MAX_ZIP_ENTRIES) {
    throw new ImportFileError(
      "Classeur XLSX refusé (trop d'éléments dans l'archive)",
      "too_large",
    );
  }
  let offset = centralOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER
    ) {
      throw new ImportFileError("Classeur XLSX illisible (archive corrompue)");
    }
    const uncompressed = buffer.readUInt32LE(offset + 24);
    if (uncompressed === 0xffffffff) {
      throw new ImportFileError("Classeur XLSX refusé (archive ZIP64)");
    }
    total += uncompressed;
    if (total > XLSX_MAX_UNCOMPRESSED_BYTES) {
      throw new ImportFileError(
        "Classeur XLSX refusé (contenu décompressé trop volumineux)",
        "too_large",
      );
    }
    offset +=
      46 +
      buffer.readUInt16LE(offset + 28) +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
  }
}

/**
 * Valeur affichable d'une cellule, sans jamais évaluer de formule : pour une
 * cellule formule, la valeur calculée enregistrée (`result`) ou vide.
 */
export function cellToString(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  const v = value as unknown as Record<string, unknown>;
  if ("formula" in v || "sharedFormula" in v) {
    const result = v.result;
    if (result === undefined || result === null) return "";
    if (typeof result === "object" && !(result instanceof Date)) {
      // Résultat en erreur (#DIV/0!…) : ignoré
      return "error" in (result as object)
        ? ""
        : cellToString(result as CellValue);
    }
    return cellToString(result as CellValue);
  }
  if (Array.isArray(v.richText)) {
    return (v.richText as { text?: string }[])
      .map((part) => part.text ?? "")
      .join("");
  }
  if ("hyperlink" in v) return cellToString(v.text as CellValue);
  if ("error" in v) return "";
  if ("text" in v) return cellToString(v.text as CellValue);
  return "";
}

/**
 * Lignes non vides de la première feuille. `maxRows` borne le nombre de
 * lignes non vides (en-tête compris).
 */
export async function readXlsxRows(
  buffer: Buffer,
  options: { maxRows?: number } = {},
): Promise<TabularRow[]> {
  assertSafeZip(buffer);
  const maxRows = options.maxRows ?? Infinity;
  const workbook = new Workbook();
  try {
    // Typage exceljs du Buffer différent de celui de @types/node
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new ImportFileError(
      "Classeur XLSX illisible",
      "unsupported_type",
    );
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ImportFileError("Classeur XLSX sans feuille");

  const rows: TabularRow[] = [];
  let tooMany = false;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (tooMany) return;
    const cells: string[] = [];
    for (let c = 1; c <= row.cellCount; c++) {
      cells.push(cellToString(row.getCell(c).value).trim());
    }
    if (isBlankRow(cells)) return;
    rows.push({ row: rowNumber, cells });
    if (rows.length > maxRows) tooMany = true;
  });
  if (tooMany) {
    throw new ImportFileError(
      `Trop de lignes : ${maxRows - 1} lignes de données au plus`,
    );
  }
  return rows;
}
