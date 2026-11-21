import { decodeTextFile, detectSeparator, parseCsv } from "./csv.parser";
import { ImportFileError } from "./import.types";

const cells = (text: string) => parseCsv(text).map((r) => r.cells);

describe("parseCsv (issue #12)", () => {
  it("détecte le séparateur ; , ou tabulation sur la première ligne", () => {
    expect(detectSeparator("a;b;c\n1,2;3")).toBe(";");
    expect(detectSeparator("a,b,c\n1;2")).toBe(",");
    expect(detectSeparator("a\tb\tc")).toBe("\t");
    expect(detectSeparator('"x;y;z",b,c')).toBe(",");
    expect(detectSeparator("seul")).toBe(";");
  });

  it("lit les champs avec ; ou ,", () => {
    expect(cells("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(cells("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("gère guillemets, guillemets doublés, séparateurs et sauts de ligne dans un champ", () => {
    const text =
      'question;option_a\n"Il a dit ""bonjour"" ; puis\nest parti";"A, B"\n';
    expect(cells(text)).toEqual([
      ["question", "option_a"],
      ['Il a dit "bonjour" ; puis\nest parti', "A, B"],
    ]);
  });

  it("retire le BOM et numérote les lignes comme un tableur (lignes vides comptées)", () => {
    const rows = parseCsv("\uFEFFquestion;type\n\nQ1;single\n;\nQ2;poll");
    expect(rows[0].cells[0]).toBe("question");
    expect(rows.map((r) => r.row)).toEqual([1, 3, 5]);
  });

  it("le numéro de ligne d'un enregistrement multi-ligne est celui de son début", () => {
    const rows = parseCsv('h\n"a\nb"\nc');
    expect(rows.map((r) => r.row)).toEqual([1, 2, 3]);
  });

  it("rogne les champs non entourés de guillemets, garde les espaces entre guillemets", () => {
    expect(cells(' a ; " b " ')).toEqual([["a", " b "]]);
  });

  it("refuse un guillemet non refermé", () => {
    expect(() => parseCsv('a;b\n"ouvert;x\n')).toThrow(/Ligne 2/);
  });

  it("borne le nombre de lignes non vides", () => {
    const text = ["h", "1", "2", "3"].join("\n");
    expect(() => parseCsv(text, { maxRecords: 3 })).toThrow(ImportFileError);
    expect(parseCsv(text, { maxRecords: 4 })).toHaveLength(4);
  });
});

describe("decodeTextFile", () => {
  it("décode l'UTF-8 et retire le BOM", () => {
    const buf = Buffer.from("\uFEFFÉnoncé;é", "utf8");
    expect(decodeTextFile(buf)).toBe("Énoncé;é");
  });

  it("se replie sur Windows-1252 (CSV Excel en français)", () => {
    const buf = Buffer.from([0xc9, 0x74, 0xe9, 0x80]);
    expect(decodeTextFile(buf)).toBe("Été€");
  });

  it("refuse un contenu binaire, une archive ZIP/XLSX ou un PDF", () => {
    const expectType = (buf: Buffer) => {
      try {
        decodeTextFile(buf);
        throw new Error("aucune erreur");
      } catch (e) {
        expect(e).toBeInstanceOf(ImportFileError);
        expect((e as ImportFileError).kind).toBe("unsupported_type");
      }
    };
    expectType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]));
    expectType(Buffer.from("%PDF-1.7"));
    expectType(Buffer.from([0x61, 0x00, 0x62]));
  });
});
