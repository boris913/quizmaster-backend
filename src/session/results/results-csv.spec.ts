import {
  buildResultsCsv,
  CSV_BOM,
  escapeCsvCell,
  resultsCsvFilename,
  toCsv,
} from "./results-csv";
import { buildSessionResults, ResultsAnswerRow } from "./session-results";

describe("escapeCsvCell", () => {
  it("laisse une valeur simple telle quelle", () => {
    expect(escapeCsvCell("Alice")).toBe("Alice");
    expect(escapeCsvCell(42)).toBe("42");
  });

  it("rend vide null et undefined", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });

  it("entoure de guillemets une valeur contenant le séparateur", () => {
    expect(escapeCsvCell("Paris; Lyon")).toBe('"Paris; Lyon"');
  });

  it("double les guillemets internes", () => {
    expect(escapeCsvCell('Le "grand" quiz')).toBe('"Le ""grand"" quiz"');
  });

  it("entoure de guillemets une valeur multiligne", () => {
    expect(escapeCsvCell("ligne 1\nligne 2")).toBe('"ligne 1\nligne 2"');
  });

  it("neutralise les formules de tableur", () => {
    expect(escapeCsvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(escapeCsvCell("+33")).toBe("'+33");
    expect(escapeCsvCell("@moi;toi")).toBe('"\'@moi;toi"');
  });
});

describe("toCsv", () => {
  it("commence par un BOM UTF-8 et utilise ; et CRLF", () => {
    const csv = toCsv([
      ["a", "b"],
      [1, "é"],
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe(`${CSV_BOM}a;b\r\n1;é\r\n`);
    expect(Buffer.from(csv, "utf-8").subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
  });
});

describe("buildResultsCsv", () => {
  const answers: ResultsAnswerRow[] = [
    {
      participant_id: "p1",
      question_id: "q1",
      answers: ["A", "C"],
      status: "answered",
      is_correct: true,
      time_taken_ms: 2500,
    },
    {
      participant_id: "p2",
      question_id: "q1",
      answers: [],
      status: "timeout",
      is_correct: false,
      time_taken_ms: null,
    },
  ];
  const results = buildSessionResults({
    session: {
      id: "s1",
      status: "finished",
      started_at: "2026-11-19T09:00:00.000Z",
      ended_at: null,
      quizzes: { title: 'Révisions "Brevet" ; maths' },
    },
    questions: [
      {
        id: "q1",
        order_index: 0,
        text: "Nombres pairs ; lesquels ?",
        type: "multiple",
        options: [{ id: "A" }, { id: "B" }, { id: "C" }],
        correct_answers: ["A", "C"],
      },
    ],
    participants: [
      { id: "p1", pseudo: 'Léa "la boss"', score: 120 },
      { id: "p2", pseudo: "Tom", score: 0 },
    ],
    answers,
  });

  it("produit l'en-tête et une ligne par participant, échappées", () => {
    const csv = buildResultsCsv(results, answers);
    const lines = csv.slice(1).split("\r\n");

    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(lines[0]).toBe(
      'Rang;Pseudo;Score;Précision (%);Réponses;Sans réponse;Temps moyen (s);"Q1 - Nombres pairs ; lesquels ?"',
    );
    expect(lines[1]).toBe('1;"Léa ""la boss""";120;100;1;0;2,5;A, C (juste)');
    expect(lines[2]).toBe("2;Tom;0;0;0;1;0;(temps écoulé)");
    expect(lines[3]).toBe("");
    expect(lines).toHaveLength(4);
  });

  it("produit un nom de fichier ASCII", () => {
    expect(resultsCsvFilename(results)).toBe(
      "resultats-revisions-brevet-maths-2026-11-19.csv",
    );
  });
});
