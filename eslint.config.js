// Flat ESLint config.
//
// Scope is deliberately limited to JavaScript (.js/.mjs/.cjs): TypeScript is
// checked by `tsc --noEmit` instead. eslint 10 cannot parse TypeScript on its
// own ("Parsing error: Unexpected token :") and @typescript-eslint/parser@8
// declares a peer range of typescript >=4.8.4 <6.1.0, which conflicts with the
// pinned typescript 7.0.2. Layer rules live in scripts/check-layers.mjs.
export default [
  {
    ignores: ["node_modules/**", "lib/**", ".omw-e2e/**", "docs/**", "coverage/**"],
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { console: "readonly", process: "readonly", URL: "readonly", Buffer: "readonly" },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
  },
];
