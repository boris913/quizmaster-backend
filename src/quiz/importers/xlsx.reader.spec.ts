import { buildXlsx } from "../../test-utils/xlsx-fixtures";
import { ImportFileError, XLSX_MAX_UNCOMPRESSED_BYTES } from "./import.types";
import { assertSafeZip, cellToString, readXlsxRows } from "./xlsx.reader";

describe("readXlsxRows (issue #12)", () => {
  it("lit la première feuille, ignore les lignes vides, garde les numéros de ligne", async () => {
    const buf = await buildXlsx([
      ["question", "points"],
      [],
      ["Q1", 100],
      ["  Q2  ", 50],
    ]);
    expect(await readXlsxRows(buf)).toEqual([
      { row: 1, cells: ["question", "points"] },
      { row: 3, cells: ["Q1", "100"] },
      { row: 4, cells: ["Q2", "50"] },
    ]);
  });

  it("n'évalue jamais les formules : valeur enregistrée uniquement", async () => {
    const buf = await buildXlsx([
      ["question", "points"],
      ["Q1", { formula: "40+60", result: 100 }],
      ["Q2", { formula: "HYPERLINK(\"http://x\")" }],
      [{ richText: [{ text: "Gras " }, { text: "et normal" }] }, 10],
    ]);
    const rows = await readXlsxRows(buf);
    expect(rows[1].cells).toEqual(["Q1", "100"]);
    expect(rows[2].cells).toEqual(["Q2", ""]);
    expect(rows[3].cells).toEqual(["Gras et normal", "10"]);
  });

  it("borne le nombre de lignes", async () => {
    const buf = await buildXlsx([["h"], ["1"], ["2"], ["3"]]);
    await expect(readXlsxRows(buf, { maxRows: 3 })).rejects.toThrow(
      /Trop de lignes/,
    );
  });

  it("refuse un fichier qui n'est pas un XLSX", async () => {
    await expect(
      readXlsxRows(Buffer.from("question;points\nQ;1")),
    ).rejects.toMatchObject({ kind: "unsupported_type" });
  });

  it("refuse une archive ZIP qui n'est pas un classeur", async () => {
    // ZIP vide valide : uniquement la fin de répertoire central
    const emptyZip = Buffer.alloc(22);
    emptyZip.writeUInt32LE(0x06054b50, 0);
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      emptyZip,
    ]);
    await expect(readXlsxRows(zip)).rejects.toBeInstanceOf(ImportFileError);
  });
});

describe("assertSafeZip : bombes ZIP", () => {
  it("refuse une taille décompressée déclarée trop grande", async () => {
    const buf = await buildXlsx([["question"], ["Q"]]);
    // Gonfle la taille décompressée déclarée de la première entrée
    const central = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    const forged = Buffer.from(buf);
    forged.writeUInt32LE(XLSX_MAX_UNCOMPRESSED_BYTES + 1, central + 24);
    expect(() => assertSafeZip(forged)).toThrow(/trop volumineux/);
    expect(() => assertSafeZip(buf)).not.toThrow();
  });
});

describe("cellToString", () => {
  it("convertit les types de cellule exceljs", () => {
    expect(cellToString(null)).toBe("");
    expect(cellToString(12.5)).toBe("12.5");
    expect(cellToString(true)).toBe("true");
    expect(cellToString(new Date("2026-01-02T00:00:00Z"))).toBe(
      "2026-01-02T00:00:00.000Z",
    );
    expect(
      cellToString({ text: "lien", hyperlink: "https://x" } as never),
    ).toBe("lien");
    expect(cellToString({ error: "#DIV/0!" } as never)).toBe("");
    expect(
      cellToString({ formula: "1/0", result: { error: "#DIV/0!" } } as never),
    ).toBe("");
  });
});
