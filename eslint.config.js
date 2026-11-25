// Flat ESLint config.
//
// Scope is deliberately limited to JavaScript (.js/.mjs/.cjs): TypeScript is
// checked by `tsc --noEmit` instead. eslint 10 cannot parse TypeScript on its
// own ("Parsing error: Unexpected token :") and @typescript-eslint/parser@8
// declares a peer range of typescript >=4.8.4 <6.1.0, which conflicts with the
// pinned typescript 7.0.2.
//
// Everything structural is therefore NOT here: layer imports, the triviumdb
// owner, prompt-seam ownership, the write-token list and both deletion gates are
// enforced by scripts/check-layers.mjs, which parses the sources itself. The
// rules below are the generic JavaScript ones only — a reader should not expect
// this file to catch anything about shape, because it cannot see TypeScript.
export default [
  {
    ignores: ["node_modules/**", "lib/**", ".omw-e2e/**", ".agents/**", "docs/**", "coverage/**"],
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
