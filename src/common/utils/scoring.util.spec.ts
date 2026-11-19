import {
  buildLeaderboard,
  calculatePoints,
  checkAnswer,
  generateSessionPassword,
} from "./scoring.util";

describe("calculatePoints", () => {
  const TIMER_S = 30;
  const MAX = 100;

  it("renvoie 0 pour une réponse fausse, quel que soit le temps", () => {
    expect(calculatePoints(false, 0, TIMER_S, MAX)).toBe(0);
    expect(calculatePoints(false, 5000, TIMER_S, MAX)).toBe(0);
  });

  it("donne le maximum pour une réponse juste instantanée", () => {
    expect(calculatePoints(true, 0, TIMER_S, MAX)).toBe(100);
  });

  it("dégrade linéairement les points avec le temps (exemples du README)", () => {
    expect(calculatePoints(true, 5000, TIMER_S, MAX)).toBe(83);
    expect(calculatePoints(true, 25000, TIMER_S, MAX)).toBe(17);
    expect(calculatePoints(true, 15000, TIMER_S, MAX)).toBe(50);
  });

  it("applique le plancher de 10 % des points max", () => {
    // 100 × (1 - 29/30) = 3 → plancher 10
    expect(calculatePoints(true, 29000, TIMER_S, MAX)).toBe(10);
    // plancher arrondi : 10 % de 150 = 15
    expect(calculatePoints(true, 44000, 45, 150)).toBe(15);
  });

  it("arrondit le résultat à l'entier le plus proche", () => {
    // 150 × (1 - 10/45) = 116.67 → 117
    expect(calculatePoints(true, 10000, 45, 150)).toBe(117);
  });

  it("renvoie 0 en cas de timeout (pas de réponse = réponse fausse)", () => {
    // Un timeout est enregistré avec is_correct = false (processTimeouts)
    expect(calculatePoints(false, TIMER_S * 1000, TIMER_S, MAX)).toBe(0);
  });

  it("[comportement actuel] une réponse juste arrivée au-delà du timer reçoit le plancher de 10 %, pas 0", () => {
    // La doc annonce « timeout → 0 », mais calculatePoints ne vérifie pas le
    // dépassement : seul le plancher s'applique. Voir la PR (bug signalé).
    expect(calculatePoints(true, 30000, TIMER_S, MAX)).toBe(10);
    expect(calculatePoints(true, 60000, TIMER_S, MAX)).toBe(10);
  });

  it("[comportement actuel] un temps négatif donne plus que les points max", () => {
    // Aucun bornage de timeTakenMs côté fonction. Voir la PR (bug signalé).
    expect(calculatePoints(true, -3000, TIMER_S, MAX)).toBe(110);
  });
});

describe("checkAnswer", () => {
  describe("question à réponse unique", () => {
    it("valide la bonne réponse", () => {
      expect(checkAnswer(["C"], ["C"], "single")).toBe(true);
    });

    it("refuse une mauvaise réponse", () => {
      expect(checkAnswer(["A"], ["C"], "single")).toBe(false);
    });

    it("refuse plusieurs réponses soumises, même si l'une est juste", () => {
      expect(checkAnswer(["A", "C"], ["C"], "single")).toBe(false);
    });

    it("refuse une soumission vide, null ou undefined (timeout)", () => {
      expect(checkAnswer([], ["C"], "single")).toBe(false);
      expect(checkAnswer(null as unknown as string[], ["C"], "single")).toBe(
        false,
      );
      expect(
        checkAnswer(undefined as unknown as string[], ["C"], "single"),
      ).toBe(false);
    });
  });

  describe("question à choix multiple", () => {
    it("valide exactement les bonnes réponses, dans n'importe quel ordre", () => {
      expect(checkAnswer(["A", "B"], ["A", "B"], "multiple")).toBe(true);
      expect(checkAnswer(["B", "A"], ["A", "B"], "multiple")).toBe(true);
    });

    it("refuse une réponse partielle (pas de points partiels)", () => {
      expect(checkAnswer(["A"], ["A", "B"], "multiple")).toBe(false);
    });

    it("refuse une réponse contenant une option en trop", () => {
      expect(checkAnswer(["A", "B", "C"], ["A", "B"], "multiple")).toBe(false);
    });

    it("refuse une réponse de même taille mais différente", () => {
      expect(checkAnswer(["A", "C"], ["A", "B"], "multiple")).toBe(false);
    });

    it("refuse les doublons qui masqueraient une réponse manquante", () => {
      expect(checkAnswer(["A", "A"], ["A", "B"], "multiple")).toBe(false);
    });

    it("refuse une soumission vide", () => {
      expect(checkAnswer([], ["A", "B"], "multiple")).toBe(false);
    });
  });

  it("ne modifie pas les tableaux passés en paramètre", () => {
    const submitted = ["B", "A"];
    const correct = ["B", "A"];
    checkAnswer(submitted, correct, "multiple");
    expect(submitted).toEqual(["B", "A"]);
    expect(correct).toEqual(["B", "A"]);
  });
});

describe("generateSessionPassword", () => {
  it("génère 6 caractères sans caractères ambigus (0, O, 1, I)", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSessionPassword()).toMatch(
        /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{6}$/,
      );
    }
  });
});

describe("buildLeaderboard", () => {
  const participants = [
    { id: "p1", pseudo: "Alice", score: 100 },
    { id: "p2", pseudo: "Bob", score: 300, last_points: 50 },
    { id: "p3", pseudo: "Chloé", score: 200, answered_current: true },
    { id: "p4", pseudo: "David", score: 50 },
  ];

  it("trie par score décroissant et attribue les rangs", () => {
    const board = buildLeaderboard(participants);
    expect(board.map((e) => e.participant_id)).toEqual([
      "p2",
      "p3",
      "p1",
      "p4",
    ]);
    expect(board.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
  });

  it("calcule les écarts au suivant et au podium", () => {
    const board = buildLeaderboard(participants);
    expect(board[0].gap_to_next).toBeNull();
    expect(board[1].gap_to_next).toBe(100);
    expect(board[3].gap_to_next).toBe(50);
    expect(board[2].gap_to_podium).toBeNull();
    expect(board[3].gap_to_podium).toBe(50);
    expect(board.map((e) => e.on_podium)).toEqual([true, true, true, false]);
  });

  it("applique les valeurs par défaut et ne modifie pas l'entrée", () => {
    const input = [...participants];
    const board = buildLeaderboard(input);
    expect(board[0]).toMatchObject({
      last_points: 50,
      answered_current: false,
    });
    expect(board[1]).toMatchObject({ last_points: 0, answered_current: true });
    expect(input).toEqual(participants);
  });

  it("renvoie une liste vide pour aucun participant", () => {
    expect(buildLeaderboard([])).toEqual([]);
  });
});
