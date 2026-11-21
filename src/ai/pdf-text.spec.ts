import { execFileSync } from "child_process";
import { join } from "path";
import { hasPdfSignature } from "./pdf-text";
import { buildTestPdf } from "../test-utils/test-pdf";

/**
 * `unpdf` charge son build PDF.js par `import()` dynamique (module ESM),
 * que Jest ne permet pas sans `--experimental-vm-modules`. L'extraction
 * réelle est donc testée dans un processus Node séparé, qui exécute le vrai
 * `pdf-text.ts` (transpilé à la volée par TypeScript) : c'est le
 * comportement de production, vérifié aussi sur la version de Node de la CI.
 */
const PDF_TEXT_SOURCE = join(__dirname, "pdf-text.ts");

const CHILD_SCRIPT = `
require("reflect-metadata");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const ts = require("typescript");
const file = process.argv[1];
const out = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2021,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
  },
}).outputText;
const m = new Module(file);
m.filename = file;
m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(out, file);
const buffer = Buffer.from(process.argv[2], "base64");
new m.exports.PdfTextExtractor()
  .extract(buffer)
  .then((text) => process.stdout.write(JSON.stringify({ text })))
  .catch((e) =>
    process.stdout.write(
      JSON.stringify({ error: e.constructor.name, message: e.message }),
    ),
  );
`;

function extractInChild(pdf: Buffer): { text?: string; error?: string } {
  const output = execFileSync(
    process.execPath,
    ["-e", CHILD_SCRIPT, PDF_TEXT_SOURCE, pdf.toString("base64")],
    { cwd: join(__dirname, "..", ".."), encoding: "utf8", timeout: 60_000 },
  );
  return JSON.parse(output);
}

describe("PDF : signature et extraction du texte (issue #11)", () => {
  it("reconnaît la signature %PDF-", () => {
    expect(hasPdfSignature(Buffer.from("%PDF-1.7\n..."))).toBe(true);
    expect(hasPdfSignature(Buffer.from("PK\u0003\u0004 zip"))).toBe(false);
    expect(hasPdfSignature(Buffer.from("%PD"))).toBe(false);
    expect(hasPdfSignature(Buffer.alloc(0))).toBe(false);
    expect(hasPdfSignature(undefined)).toBe(false);
  });

  it("extrait le texte d'un vrai PDF (unpdf, sans dépendance native)", () => {
    const result = extractInChild(
      buildTestPdf(["La photosynthese produit du dioxygene.", "Ligne deux."]),
    );
    expect(result.error).toBeUndefined();
    expect(result.text).toContain("La photosynthese produit du dioxygene.");
    expect(result.text).toContain("Ligne deux.");
  }, 70_000);

  it("renvoie un texte vide pour un PDF sans texte (scanné)", () => {
    const result = extractInChild(buildTestPdf([]));
    expect(result.error).toBeUndefined();
    expect(result.text?.trim()).toBe("");
  }, 70_000);

  it("lève UnreadablePdfError pour un PDF corrompu", () => {
    const result = extractInChild(
      Buffer.from("%PDF-1.4\nceci n'est pas un PDF"),
    );
    expect(result.error).toBe("UnreadablePdfError");
  }, 70_000);
});
