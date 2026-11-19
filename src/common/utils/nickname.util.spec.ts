import {
  NICKNAME_ERRORS,
  formatGeneratedNickname,
  generateNickname,
  generateNicknameSuggestions,
  getNicknameError,
  isGeneratedNickname,
  isNicknameAllowed,
  normalizeForModeration,
} from "./nickname.util";
import {
  GENERATOR_ADJECTIVES,
  GENERATOR_NOUNS,
  MILD_TERMS,
  NICKNAME_EXCEPTIONS,
  SEVERE_TERMS,
} from "./nickname-wordlists";

/** Générateur pseudo-aléatoire déterministe (suite de valeurs fournie). */
const sequence = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

// Les tests s'appuient sur des termes grossiers modérés (« merde », « con »)
// et sur « nazi » pour les recherches en sous-chaîne.
describe("normalizeForModeration", () => {
  it("met en minuscules, retire les accents et sépare le camelCase", () => {
    expect(normalizeForModeration("ÉlèveCurieux")).toBe("eleve curieux");
  });

  it("traduit le leet speak (4→a 3→e 1→i 0→o 5→s @→a)", () => {
    expect(normalizeForModeration("4@31 05")).toBe("aaei os");
  });

  it("remplace la ponctuation et les autres chiffres par des espaces", () => {
    expect(normalizeForModeration("m.e-r_d e!2")).toBe("m e r d ei");
  });
});

describe("isNicknameAllowed", () => {
  it.each(["merde", "Merde", "MERDE", "con"])("refuse « %s »", (pseudo) => {
    expect(isNicknameAllowed(pseudo)).toBe(false);
  });

  it.each(["M3rd3", "m3rde", "C0N", "c@c@"])(
    "refuse le leet speak « %s »",
    (pseudo) => {
      expect(isNicknameAllowed(pseudo)).toBe(false);
    },
  );

  it.each(["Mèrdé", "MÊRDE", "cön"])(
    "refuse malgré les accents « %s »",
    (pseudo) => {
      expect(isNicknameAllowed(pseudo)).toBe(false);
    },
  );

  it.each(["Merdeeee", "Coooon", "m.e.r.d.e", "c-o-n", "M_E_R_D_E"])(
    "refuse les lettres répétées ou séparées « %s »",
    (pseudo) => {
      expect(isNicknameAllowed(pseudo)).toBe(false);
    },
  );

  it.each(["Gros_Con", "GrosCon", "gros-merde", "Lapin merde", "merde42"])(
    "refuse un terme modéré employé comme mot entier « %s »",
    (pseudo) => {
      expect(isNicknameAllowed(pseudo)).toBe(false);
    },
  );

  it.each(["SuperNazi", "xxn4z1xx", "Le-Na-Zi"])(
    "refuse un terme grave même à l'intérieur d'un mot « %s »",
    (pseudo) => {
      expect(isNicknameAllowed(pseudo)).toBe(false);
    },
  );

  it.each(["Député", "Computer", "Unique", "Technique", "Scunthorpe", "Niger"])(
    "accepte les exceptions « %s »",
    (pseudo) => {
      expect(isNicknameAllowed(pseudo)).toBe(true);
    },
  );

  it.each([
    "Connor",
    "Constance",
    "Pascal",
    "Cassandra",
    "Anass",
    "Assia",
    "Bastien",
    "Habiba",
    "Dominique",
    "Véronique",
    "Monique",
    "Nazim",
    "Nicolas",
    "Lucas",
    "Hugo",
    "Inès",
    "Chloé",
    "Mathéo",
    "Léa",
    "Yanis",
    "Kenza",
    "Sacha",
    "Jules_2010",
    "Titouan-du-93",
  ])("accepte le prénom courant « %s » (faux positif)", (pseudo) => {
    expect(isNicknameAllowed(pseudo)).toBe(true);
  });

  it("refuse un pseudo vide ou sans lettre", () => {
    expect(isNicknameAllowed("")).toBe(false);
    expect(isNicknameAllowed("___")).toBe(false);
  });

  it("les listes sont écrites sous forme normalisée", () => {
    for (const word of [
      ...SEVERE_TERMS,
      ...MILD_TERMS,
      ...NICKNAME_EXCEPTIONS,
    ]) {
      expect(normalizeForModeration(word)).toBe(word);
    }
  });
});

describe("générateur de pseudos", () => {
  it("dispose d'environ 100 noms et 100 adjectifs, sans doublon", () => {
    const nouns = GENERATOR_NOUNS.map((n) => n.word);
    const adjectives = GENERATOR_ADJECTIVES.map((a) => a.m);
    expect(nouns.length).toBeGreaterThanOrEqual(95);
    expect(adjectives.length).toBeGreaterThanOrEqual(95);
    expect(new Set(nouns).size).toBe(nouns.length);
    expect(new Set(adjectives).size).toBe(adjectives.length);
  });

  it("accorde l'adjectif au genre du nom", () => {
    const curieux = { m: "Curieux", f: "Curieuse" };
    expect(formatGeneratedNickname({ word: "Loutre", gender: "f" }, curieux)).toBe(
      "Loutre Curieuse",
    );
    expect(formatGeneratedNickname({ word: "Hibou", gender: "m" }, curieux)).toBe(
      "Hibou Curieux",
    );
  });

  it("generateNickname utilise le genre du nom tiré", () => {
    for (let i = 0; i < 200; i++) {
      const [noun, adjective] = generateNickname().split(" ");
      const gender = GENERATOR_NOUNS.find((n) => n.word === noun)!.gender;
      expect(GENERATOR_ADJECTIVES.some((a) => a[gender] === adjective)).toBe(
        true,
      );
    }
  });

  it("toutes les combinaisons passent le filtre et le format du DTO", () => {
    const dtoPattern = /^[\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+)*$/u;
    for (const noun of GENERATOR_NOUNS) {
      for (const adjective of GENERATOR_ADJECTIVES) {
        const pseudo = formatGeneratedNickname(noun, adjective);
        expect(pseudo.length).toBeLessThanOrEqual(50);
        expect(dtoPattern.test(pseudo)).toBe(true);
        if (!isNicknameAllowed(pseudo)) {
          throw new Error(`Pseudo généré refusé par le filtre : ${pseudo}`);
        }
      }
    }
  });

  it("renvoie 3 propositions distinctes, même si le tirage se répète", () => {
    const random = sequence([0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.9, 0.9]);
    const suggestions = generateNicknameSuggestions(3, [], random);
    expect(suggestions).toHaveLength(3);
    expect(new Set(suggestions).size).toBe(3);
  });

  it("exclut les pseudos déjà pris (sans tenir compte de la casse)", () => {
    const first = generateNickname(sequence([0, 0]));
    const random = sequence([0, 0, 0.5, 0.5, 0.9, 0.9, 0.3, 0.3]);
    const suggestions = generateNicknameSuggestions(
      3,
      [first.toUpperCase()],
      random,
    );
    expect(suggestions).toHaveLength(3);
    expect(suggestions).not.toContain(first);
  });

  it("isGeneratedNickname reconnaît uniquement les combinaisons accordées", () => {
    expect(isGeneratedNickname("Loutre Curieuse")).toBe(true);
    expect(isGeneratedNickname("hibou curieux")).toBe(true);
    expect(isGeneratedNickname("Loutre Curieux")).toBe(false);
    expect(isGeneratedNickname("Hibou")).toBe(false);
    expect(isGeneratedNickname("Toto")).toBe(false);
  });
});

describe("getNicknameError", () => {
  it("mode free : refuse un pseudo interdit, accepte un pseudo libre", () => {
    expect(getNicknameError("M3rd3", "free")).toBe(NICKNAME_ERRORS.notAllowed);
    expect(getNicknameError("Connor", "free")).toBeNull();
    // Sessions antérieures à la migration : mode absent = free
    expect(getNicknameError("Connor", undefined)).toBeNull();
  });

  it("mode generated : exige un pseudo issu du générateur", () => {
    expect(getNicknameError("Connor", "generated")).toBe(
      NICKNAME_ERRORS.mustBeGenerated,
    );
    expect(getNicknameError("Hibou Curieux", "generated")).toBeNull();
  });
});
