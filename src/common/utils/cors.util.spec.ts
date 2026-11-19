import {
  DEFAULT_DEV_ORIGIN,
  corsOriginCallback,
  getAllowedOrigins,
  isOriginAllowed,
  isUsingDefaultOrigins,
} from "./cors.util";

describe("cors.util", () => {
  describe("getAllowedOrigins", () => {
    it("se replie sur localhost:3000 sans configuration", () => {
      expect(getAllowedOrigins({})).toEqual([DEFAULT_DEV_ORIGIN]);
      expect(isUsingDefaultOrigins({})).toBe(true);
    });

    it("lit CORS_ORIGINS (liste séparée par des virgules)", () => {
      const env = {
        CORS_ORIGINS:
          " https://quiz.example.fr/ , https://www.quiz.example.fr,,",
      };
      expect(getAllowedOrigins(env)).toEqual([
        "https://quiz.example.fr",
        "https://www.quiz.example.fr",
      ]);
      expect(isUsingDefaultOrigins(env)).toBe(false);
    });

    it("CORS_ORIGINS est prioritaire sur FRONTEND_URL", () => {
      expect(
        getAllowedOrigins({
          CORS_ORIGINS: "https://a.example.fr",
          FRONTEND_URL: "https://b.example.fr",
        }),
      ).toEqual(["https://a.example.fr"]);
    });

    it("utilise FRONTEND_URL à défaut (compatibilité)", () => {
      expect(
        getAllowedOrigins({ FRONTEND_URL: "https://b.example.fr" }),
      ).toEqual(["https://b.example.fr"]);
    });

    it("ignore le joker *", () => {
      expect(getAllowedOrigins({ CORS_ORIGINS: "*" })).toEqual([
        DEFAULT_DEV_ORIGIN,
      ]);
    });
  });

  describe("isOriginAllowed", () => {
    const env = { CORS_ORIGINS: "https://quiz.example.fr" };

    it("accepte une origine listée", () => {
      expect(isOriginAllowed("https://quiz.example.fr", env)).toBe(true);
    });

    it("refuse une origine non listée", () => {
      expect(isOriginAllowed("https://evil.example.com", env)).toBe(false);
      expect(isOriginAllowed("http://localhost:3000", env)).toBe(false);
    });

    it("laisse passer une requête sans en-tête Origin", () => {
      expect(isOriginAllowed(undefined, env)).toBe(true);
    });
  });

  describe("corsOriginCallback", () => {
    const saved = process.env.CORS_ORIGINS;
    afterEach(() => {
      if (saved === undefined) delete process.env.CORS_ORIGINS;
      else process.env.CORS_ORIGINS = saved;
    });

    it("lit process.env à chaque appel", () => {
      const cb = jest.fn();
      process.env.CORS_ORIGINS = "https://quiz.example.fr";
      corsOriginCallback("https://quiz.example.fr", cb);
      corsOriginCallback("https://evil.example.com", cb);
      expect(cb).toHaveBeenNthCalledWith(1, null, true);
      expect(cb).toHaveBeenNthCalledWith(2, null, false);
    });
  });
});
