import { Injectable } from "@nestjs/common";

/** Signature d'un fichier PDF : les octets `%PDF-` en tête de fichier. */
const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

/** Types MIME acceptés pour le champ `file`. */
export const PDF_MIME_TYPES = ["application/pdf"] as const;

/** Vrai si le contenu commence par la signature `%PDF-`. */
export function hasPdfSignature(buffer: Buffer | undefined | null): boolean {
  return (
    !!buffer &&
    buffer.length >= PDF_MAGIC.length &&
    buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)
  );
}

/** PDF illisible (corrompu, chiffré…). */
export class UnreadablePdfError extends Error {}

/**
 * Extraction du texte d'un PDF, côté serveur, avec `unpdf` (build
 * « serverless » de PDF.js, pur JavaScript, sans dépendance native).
 * Isolée dans un service injectable pour être remplacée dans les tests.
 */
@Injectable()
export class PdfTextExtractor {
  async extract(buffer: Buffer): Promise<string> {
    try {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      try {
        const { text } = await extractText(pdf, { mergePages: true });
        return text;
      } finally {
        await pdf.destroy().catch(() => undefined);
      }
    } catch (error) {
      throw new UnreadablePdfError(
        error instanceof Error ? error.message : "PDF illisible",
      );
    }
  }
}
