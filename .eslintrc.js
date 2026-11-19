// Config ESLint minimale (ESLint 8 + @typescript-eslint 6).
// Le formatage est laissé à Prettier (`npm run format`) : aucune règle de style ici.
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: [".eslintrc.js", "dist", "node_modules", "coverage"],
  rules: {
    // Le code s'appuie largement sur `any` (réponses Supabase non typées) :
    // à réactiver progressivement quand les types générés seront en place.
    "@typescript-eslint/no-explicit-any": "off",
    // Paramètres et variables préfixés par `_` volontairement ignorés.
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
  },
};
