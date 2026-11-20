import {
  buildLeaderboard,
  calculatePoints,
  checkAnswer,
  computeClassProgress,
  computeServerTimeTakenMs,
  generateSessionPassword,
  normalizeSessionCode,
  SESSION_CODE_ALPHABET,
  SESSION_CODE_LENGTH,
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

  it("accepte une réponse juste pile à la fin du timer (plancher de 10 %)", () => {
    // La fenêtre de réponse est [0, timerMs] inclus.
    expect(calculatePoints(true, 30000, TIMER_S, MAX)).toBe(10);
  });

  it("renvoie 0 pour une réponse juste arrivée après la fin du timer", () => {
    expect(calculatePoints(true, 30001, TIMER_S, MAX)).toBe(0);
    expect(calculatePoints(true, 60000, TIMER_S, MAX)).toBe(0);
  });

  it("ramène un temps négatif à 0 : jamais plus que les points max", () => {
    expect(calculatePoints(true, -3000, TIMER_S, MAX)).toBe(100);
    expect(calculatePoints(true, -1, TIMER_S, MAX)).toBe(100);
    expect(calculatePoints(true, -1e12, TIMER_S, MAX)).toBe(100);
  });

  it("traite un temps non numérique comme hors délai", () => {
    expect(calculatePoints(true, NaN, TIMER_S, MAX)).toBe(0);
    expect(calculatePoints(true, Infinity, TIMER_S, MAX)).toBe(0);
    expect(calculatePoints(true, -Infinity, TIMER_S, MAX)).toBe(0);
  });

  it("renvoie 0 (sans division par zéro) si timerSeconds <= 0", () => {
    expect(calculatePoints(true, 0, 0, MAX)).toBe(0);
    expect(calculatePoints(true, 1000, 0, MAX)).toBe(0);
    expect(calculatePoints(true, 0, -10, MAX)).toBe(0);
    expect(calculatePoints(true, 0, NaN, MAX)).toBe(0);
  });

  it("renvoie 0 si maxPoints n'est pas strictement positif", () => {
    expect(calculatePoints(true, 0, TIMER_S, 0)).toBe(0);
    expect(calculatePoints(true, 0, TIMER_S, -100)).toBe(0);
  });

  it("garantit un entier entre 0 et maxPoints pour toute entrée", () => {
    const times = [-1e9, -3000, -1, 0, 1, 999, 15000, 29999, 30000, 30001, 1e9];
    const timers = [-5, 0, 0.001, 1, 30, 120];
    const maxes = [1, 5, 10, 100, 150, 1000];
    for (const t of times) {
      for (const timer of timers) {
        for (const max of maxes) {
          for (const correct of [true, false]) {
            const points = calculatePoints(correct, t, timer, max);
            expect(Number.isInteger(points)).toBe(true);
            expect(points).toBeGreaterThanOrEqual(0);
            expect(points).toBeLessThanOrEqual(max);
          }
        }
      }
    }
  });
});

describe("calculatePoints : modes de score (issue #8)", () => {
  const TIMER_S = 30;
  const MAX = 100;

  it('le mode par défaut est "speed" (comportement inchangé)', () => {
    for (const t of [0, 5000, 15000, 25000, 29000, 30000, 30001]) {
      expect(calculatePoints(true, t, TIMER_S, MAX)).toBe(
        calculatePoints(true, t, TIMER_S, MAX, "speed"),
      );
    }
    expect(calculatePoints(true, 15000, TIMER_S, MAX, "speed")).toBe(50);
  });

  it("accuracy : une bonne réponse dans le temps vaut maxPoints quel que soit le temps", () => {
    for (const t of [0, 1, 5000, 15000, 29999]) {
      expect(calculatePoints(true, t, TIMER_S, MAX, "accuracy")).toBe(100);
    }
    expect(calculatePoints(true, 44000, 45, 150, "accuracy")).toBe(150);
  });

  it("accuracy : bornes de la fenêtre de réponse [0, timerMs] inclus", () => {
    expect(calculatePoints(true, 30000, TIMER_S, MAX, "accuracy")).toBe(100);
    expect(calculatePoints(true, -3000, TIMER_S, MAX, "accuracy")).toBe(100);
  });

  it("accuracy : une réponse hors délai vaut toujours 0", () => {
    expect(calculatePoints(true, 30001, TIMER_S, MAX, "accuracy")).toBe(0);
    expect(calculatePoints(true, 60000, TIMER_S, MAX, "accuracy")).toBe(0);
    expect(calculatePoints(true, NaN, TIMER_S, MAX, "accuracy")).toBe(0);
    expect(calculatePoints(true, Infinity, TIMER_S, MAX, "accuracy")).toBe(0);
  });

  it("accuracy : une réponse fausse vaut 0", () => {
    expect(calculatePoints(false, 0, TIMER_S, MAX, "accuracy")).toBe(0);
    expect(calculatePoints(false, 10000, TIMER_S, MAX, "accuracy")).toBe(0);
  });

  it("accuracy : timer ou maxPoints invalides → 0", () => {
    expect(calculatePoints(true, 0, 0, MAX, "accuracy")).toBe(0);
    expect(calculatePoints(true, 0, NaN, MAX, "accuracy")).toBe(0);
    expect(calculatePoints(true, 0, TIMER_S, 0, "accuracy")).toBe(0);
    expect(calculatePoints(true, 0, TIMER_S, -5, "accuracy")).toBe(0);
  });

  it('un mode inconnu est traité comme "speed"', () => {
    expect(calculatePoints(true, 15000, TIMER_S, MAX, "autre" as any)).toBe(50);
  });

  it("accuracy : toujours un entier entre 0 et maxPoints", () => {
    for (const t of [-1e9, 0, 15000, 30000, 30001, 1e9]) {
      for (const max of [1, 10, 100, 150, 1000]) {
        const points = calculatePoints(true, t, TIMER_S, max, "accuracy");
        expect(Number.isInteger(points)).toBe(true);
        expect(points).toBeGreaterThanOrEqual(0);
        expect(points).toBeLessThanOrEqual(max);
      }
    }
  });
});

describe("computeClassProgress (issue #8)", () => {
  it("calcule la précision de la classe en pourcentage entier", () => {
    const progress = computeClassProgress([
      { participant_id: "p1", is_correct: true },
      { participant_id: "p1", is_correct: true },
      { participant_id: "p2", is_correct: false },
    ]);
    // 2 bonnes réponses sur 3 attendues → 66.67 → 67
    expect(progress.classAccuracy).toBe(67);
    expect(progress.correctByParticipant.get("p1")).toBe(2);
    expect(progress.correctByParticipant.has("p2")).toBe(false);
  });

  it("compte les absences (lignes timeout, is_correct false ou null) comme attendues", () => {
    const progress = computeClassProgress([
      { participant_id: "p1", is_correct: true },
      { participant_id: "p2", is_correct: null },
      { participant_id: "p3", is_correct: false },
      { participant_id: "p4", is_correct: false },
    ]);
    expect(progress.classAccuracy).toBe(25);
  });

  it("renvoie 0 sans réponse", () => {
    const progress = computeClassProgress([]);
    expect(progress.classAccuracy).toBe(0);
    expect(progress.correctByParticipant.size).toBe(0);
  });
});

describe("computeServerTimeTakenMs", () => {
  const START = "2026-01-01T10:00:00.000Z";
  const startMs = new Date(START).getTime();

  it("calcule l'écart entre l'heure serveur et le début de la question", () => {
    expect(computeServerTimeTakenMs(START, startMs + 4200)).toBe(4200);
    expect(computeServerTimeTakenMs(new Date(START), startMs + 10)).toBe(10);
  });

  it("ne renvoie jamais un temps négatif (horloge en avance)", () => {
    expect(computeServerTimeTakenMs(START, startMs - 5000)).toBe(0);
  });

  it("renvoie null si l'heure de début est absente ou invalide", () => {
    expect(computeServerTimeTakenMs(null)).toBeNull();
    expect(computeServerTimeTakenMs(undefined)).toBeNull();
    expect(computeServerTimeTakenMs("pas une date")).toBeNull();
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
  it("l'alphabet exclut les caractères ambigus 0, O, 1, I, L", () => {
    for (const c of ["0", "O", "1", "I", "L"]) {
      expect(SESSION_CODE_ALPHABET).not.toContain(c);
    }
    expect(SESSION_CODE_ALPHABET).toMatch(/^[A-Z2-9]+$/);
    expect(new Set(SESSION_CODE_ALPHABET).size).toBe(
      SESSION_CODE_ALPHABET.length,
    );
  });

  it("génère 6 caractères majuscules pris dans l'alphabet", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateSessionPassword();
      expect(code).toHaveLength(SESSION_CODE_LENGTH);
      expect(SESSION_CODE_LENGTH).toBe(6);
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
    }
  });
});

describe("normalizeSessionCode", () => {
  it("supprime les espaces et passe en majuscules", () => {
    expect(normalizeSessionCode("  ab c 23 ")).toBe("ABC23");
    expect(normalizeSessionCode("abc\t234\n")).toBe("ABC234");
    expect(normalizeSessionCode("XyZ789")).toBe("XYZ789");
  });

  it("accepte les anciens codes contenant L (pas de filtrage d'alphabet)", () => {
    expect(normalizeSessionCode("lmn 234")).toBe("LMN234");
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
