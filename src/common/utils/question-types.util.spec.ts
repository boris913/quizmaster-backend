import {
  buildAnswerDistribution,
  isGradedQuestionType,
  normalizeShortAnswer,
  scrambleOrderingIds,
  shuffleOrderingOptions,
  validateQuestionByType,
} from "./question-types.util";
import { checkAnswer } from "./scoring.util";

const opts = (...ids: string[]) => ids.map((id) => ({ id, text: `T${id}` }));

describe("normalizeShortAnswer (issue #7)", () => {
  it.each([
    ["Paris", "paris"],
    ["  PARIS  ", "paris"],
    ["Élysée", "elysee"],
    ["ça  va   bien", "ca va bien"],
    ["Paris.", "paris"],
    ["Paris !", "paris"],
    ["Paris?!…", "paris"],
    ["l’Élysée", "l'elysee"],
    ["Saint-Étienne", "saint-etienne"],
    ["\tNew York\n", "new york"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeShortAnswer(input)).toBe(expected);
  });

  it("ne retire que la ponctuation finale", () => {
    expect(normalizeShortAnswer("3.14")).toBe("3.14");
    expect(normalizeShortAnswer("a, b")).toBe("a, b");
  });

  it("renvoie une chaîne vide pour une valeur non textuelle ou vide", () => {
    expect(normalizeShortAnswer(undefined)).toBe("");
    expect(normalizeShortAnswer(42)).toBe("");
    expect(normalizeShortAnswer(" ... ")).toBe("");
  });
});

describe("checkAnswer par type (issue #7)", () => {
  describe("single (inchangé)", () => {
    it("une seule bonne réponse", () => {
      expect(checkAnswer(["B"], ["B"], "single")).toBe(true);
      expect(checkAnswer(["A"], ["B"], "single")).toBe(false);
      expect(checkAnswer(["A", "B"], ["B"], "single")).toBe(false);
      expect(checkAnswer([], ["B"], "single")).toBe(false);
    });
  });

  describe("multiple (inchangé)", () => {
    it("ensemble exact, ordre indifférent", () => {
      expect(checkAnswer(["C", "A"], ["A", "C"], "multiple")).toBe(true);
      expect(checkAnswer(["A"], ["A", "C"], "multiple")).toBe(false);
      expect(checkAnswer(["A", "B", "C"], ["A", "C"], "multiple")).toBe(false);
    });
  });

  describe("true_false", () => {
    it("valide la bonne valeur", () => {
      expect(checkAnswer(["true"], ["true"], "true_false")).toBe(true);
      expect(checkAnswer(["false"], ["false"], "true_false")).toBe(true);
    });
    it("refuse la mauvaise valeur, les deux valeurs, le vide, la casse", () => {
      expect(checkAnswer(["false"], ["true"], "true_false")).toBe(false);
      expect(checkAnswer(["true", "false"], ["true"], "true_false")).toBe(
        false,
      );
      expect(checkAnswer([], ["true"], "true_false")).toBe(false);
      expect(checkAnswer(["TRUE"], ["true"], "true_false")).toBe(false);
    });
  });

  describe("ordering : séquence exacte, sans tri", () => {
    const correct = ["C", "A", "D", "B"];
    it("valide la séquence exacte", () => {
      expect(checkAnswer(["C", "A", "D", "B"], correct, "ordering")).toBe(true);
    });
    it("refuse les mêmes ids dans un autre ordre (pas de tri)", () => {
      expect(checkAnswer(["A", "B", "C", "D"], correct, "ordering")).toBe(
        false,
      );
      expect(checkAnswer(["C", "A", "B", "D"], correct, "ordering")).toBe(
        false,
      );
    });
    it("refuse une séquence incomplète, trop longue, avec doublon ou vide", () => {
      expect(checkAnswer(["C", "A", "D"], correct, "ordering")).toBe(false);
      expect(checkAnswer(["C", "A", "D", "B", "B"], correct, "ordering")).toBe(
        false,
      );
      expect(checkAnswer(["C", "A", "D", "D"], correct, "ordering")).toBe(
        false,
      );
      expect(checkAnswer([], correct, "ordering")).toBe(false);
      expect(checkAnswer(["A"], [], "ordering")).toBe(false);
    });
  });

  describe("short_answer : comparaison normalisée", () => {
    const variants = ["Paris", "Ville Lumière"];
    it.each([
      "paris",
      "PARIS",
      "  Paris  ",
      "Paris.",
      "Paris !",
      "ville lumiere",
      "Ville   Lumière ?",
    ])("accepte %j", (answer) => {
      expect(checkAnswer([answer], variants, "short_answer")).toBe(true);
    });
    it.each(["Pari", "Lyon", "", "   ", "P.aris", "Paris France"])(
      "refuse %j",
      (answer) => {
        expect(checkAnswer([answer], variants, "short_answer")).toBe(false);
      },
    );
    it("refuse plusieurs textes ou aucun", () => {
      expect(checkAnswer(["Paris", "Lyon"], variants, "short_answer")).toBe(
        false,
      );
      expect(checkAnswer([], variants, "short_answer")).toBe(false);
    });
    it("ignore une variante vide", () => {
      expect(checkAnswer(["..."], ["", " "], "short_answer")).toBe(false);
    });
  });

  describe("poll : jamais juste", () => {
    it("quelle que soit la réponse", () => {
      expect(checkAnswer(["A"], [], "poll")).toBe(false);
      expect(checkAnswer(["A"], ["A"], "poll")).toBe(false);
    });
  });

  it("un type inconnu n'est jamais juste", () => {
    expect(checkAnswer(["A"], ["A"], "inconnu" as any)).toBe(false);
  });

  it("isGradedQuestionType : seul poll n'est pas noté", () => {
    expect(isGradedQuestionType("poll")).toBe(false);
    for (const t of [
      "single",
      "multiple",
      "true_false",
      "ordering",
      "short_answer",
    ]) {
      expect(isGradedQuestionType(t)).toBe(true);
    }
  });
});

describe("validateQuestionByType (issue #7)", () => {
  const valid = (q: any) => expect(validateQuestionByType(q)).toEqual([]);
  const invalid = (q: any, fragment: string) =>
    expect(validateQuestionByType(q).join(" | ")).toContain(fragment);

  it("type inconnu", () => {
    invalid({ type: "essay", options: [], correct_answers: [] }, "type");
  });

  it("single : 2 à 4 options A-D, exactement 1 bonne réponse", () => {
    valid({ type: "single", options: opts("A", "B"), correct_answers: ["B"] });
    invalid(
      { type: "single", options: opts("A", "B"), correct_answers: ["A", "B"] },
      "exactement 1",
    );
    invalid(
      { type: "single", options: opts("A"), correct_answers: ["A"] },
      "entre 2 et 4",
    );
    invalid(
      { type: "single", options: opts("A", "E"), correct_answers: ["A"] },
      "ids d'option invalides",
    );
    invalid(
      { type: "single", options: opts("A", "B"), correct_answers: ["C"] },
      "ne correspond à aucune option",
    );
    invalid(
      { type: "single", options: opts("A", "A"), correct_answers: ["A"] },
      "uniques",
    );
  });

  it("multiple : au moins 1 bonne réponse, sans doublon", () => {
    valid({
      type: "multiple",
      options: opts("A", "B", "C"),
      correct_answers: ["A", "C"],
    });
    invalid(
      { type: "multiple", options: opts("A", "B"), correct_answers: [] },
      "au moins 1",
    );
    invalid(
      {
        type: "multiple",
        options: opts("A", "B"),
        correct_answers: ["A", "A"],
      },
      "double",
    );
  });

  it("true_false : 2 options fixes (ou aucune), ['true'] ou ['false']", () => {
    valid({ type: "true_false", correct_answers: ["true"] });
    valid({ type: "true_false", options: [], correct_answers: ["false"] });
    valid({
      type: "true_false",
      options: [
        { id: "false", text: "Non" },
        { id: "true", text: "Oui" },
      ],
      correct_answers: ["false"],
    });
    invalid(
      {
        type: "true_false",
        options: opts("A", "B"),
        correct_answers: ["true"],
      },
      "2 options fixes",
    );
    invalid(
      {
        type: "true_false",
        options: [{ id: "true", text: "Vrai" }],
        correct_answers: ["true"],
      },
      "2 options fixes",
    );
    invalid({ type: "true_false", correct_answers: ["A"] }, '["true"]');
    invalid({ type: "true_false", correct_answers: [] }, '["true"]');
    invalid(
      { type: "true_false", correct_answers: ["true", "false"] },
      '["true"]',
    );
  });

  it("ordering : 3 à 6 options A-F, permutation complète des ids", () => {
    valid({
      type: "ordering",
      options: opts("A", "B", "C"),
      correct_answers: ["B", "C", "A"],
    });
    valid({
      type: "ordering",
      options: opts("A", "B", "C", "D", "E", "F"),
      correct_answers: ["F", "E", "D", "C", "B", "A"],
    });
    invalid(
      {
        type: "ordering",
        options: opts("A", "B"),
        correct_answers: ["A", "B"],
      },
      "entre 3 et 6",
    );
    invalid(
      {
        type: "ordering",
        options: opts("A", "B", "C"),
        correct_answers: ["A", "B"],
      },
      "tous les ids",
    );
    invalid(
      {
        type: "ordering",
        options: opts("A", "B", "C"),
        correct_answers: ["A", "B", "B"],
      },
      "tous les ids",
    );
    invalid(
      {
        type: "ordering",
        options: opts("A", "B", "C"),
        correct_answers: ["A", "B", "D"],
      },
      "tous les ids",
    );
  });

  it("short_answer : sans options, 1 à 20 variantes non vides", () => {
    valid({ type: "short_answer", correct_answers: ["Paris"] });
    valid({ type: "short_answer", options: [], correct_answers: ["a", "b"] });
    invalid(
      { type: "short_answer", options: opts("A"), correct_answers: ["Paris"] },
      "pas d'options",
    );
    invalid({ type: "short_answer", correct_answers: [] }, "entre 1 et 20");
    invalid(
      {
        type: "short_answer",
        correct_answers: Array.from({ length: 21 }, (_, i) => `v${i}`),
      },
      "entre 1 et 20",
    );
    invalid({ type: "short_answer", correct_answers: ["  "] }, "vide");
    invalid(
      { type: "short_answer", correct_answers: ["x".repeat(101)] },
      "trop longue",
    );
  });

  it("poll : 2 à 6 options A-F, aucune bonne réponse", () => {
    valid({ type: "poll", options: opts("A", "B", "C", "D", "E") });
    valid({ type: "poll", options: opts("A", "B"), correct_answers: [] });
    invalid(
      { type: "poll", options: opts("A", "B"), correct_answers: ["A"] },
      "pas de bonne réponse",
    );
    invalid({ type: "poll", options: opts("A") }, "entre 2 et 6");
  });
});

describe("mélange des options ordering (issue #7)", () => {
  it("shuffleOrderingOptions ne renvoie jamais l'ordre attendu et garde les mêmes options", () => {
    const options = opts("A", "B", "C");
    const correct = ["A", "B", "C"];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const shuffled = shuffleOrderingOptions(options, correct);
      const ids = shuffled.map((o) => o.id);
      expect(ids.join("")).not.toBe("ABC");
      expect([...ids].sort()).toEqual(["A", "B", "C"]);
      seen.add(ids.join(""));
    }
    // Plusieurs ordres différents sont produits (aléa)
    expect(seen.size).toBeGreaterThan(1);
  });

  it("scrambleOrderingIds garde la séquence de textes attendue", () => {
    const options = [
      { id: "A", text: "Un" },
      { id: "B", text: "Deux" },
      { id: "C", text: "Trois" },
      { id: "D", text: "Quatre" },
    ];
    const letters = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const result = scrambleOrderingIds(options, ["A", "B", "C", "D"]);
      const byId = new Map(result.options.map((o) => [o.id, o.text]));
      expect(result.correct_answers.map((id) => byId.get(id))).toEqual([
        "Un",
        "Deux",
        "Trois",
        "Quatre",
      ]);
      // Options triées par id, mêmes ids qu'en entrée
      expect(result.options.map((o) => o.id)).toEqual(["A", "B", "C", "D"]);
      letters.add(result.correct_answers.join(""));
    }
    // Les ids ne trahissent plus l'ordre : plusieurs correspondances tirées
    expect(letters.size).toBeGreaterThan(1);
  });
});

describe("buildAnswerDistribution (issue #7)", () => {
  it("choix (single, multiple, true_false, poll) : par option, 0 par défaut", () => {
    expect(
      buildAnswerDistribution("multiple", opts("A", "B", "C"), [
        ["A", "C"],
        ["A"],
        ["A", "A"],
        ["Z"],
      ]),
    ).toEqual({ A: 3, B: 0, C: 1 });
    expect(
      buildAnswerDistribution(
        "true_false",
        [
          { id: "true", text: "Vrai" },
          { id: "false", text: "Faux" },
        ],
        [["true"], ["true"], ["false"]],
      ),
    ).toEqual({ true: 2, false: 1 });
    expect(buildAnswerDistribution("poll", opts("A", "B"), [["B"]])).toEqual({
      A: 0,
      B: 1,
    });
  });

  it("ordering : distribution vide", () => {
    expect(
      buildAnswerDistribution("ordering", opts("A", "B", "C"), [
        ["A", "B", "C"],
      ]),
    ).toEqual({});
  });

  it("short_answer : par réponse normalisée, 20 plus fréquentes", () => {
    expect(
      buildAnswerDistribution(
        "short_answer",
        [],
        [["Paris"], ["paris !"], ["Lyon"], [""], []],
      ),
    ).toEqual({ paris: 2, lyon: 1 });

    const many = Array.from({ length: 30 }, (_, i) => [`r${i}`]);
    many.push(["r29"]);
    const distribution = buildAnswerDistribution("short_answer", [], many);
    expect(Object.keys(distribution)).toHaveLength(20);
    expect(distribution.r29).toBe(2);
  });
});
