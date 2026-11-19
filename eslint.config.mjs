// Lint gate for src (docs/code-quality-audit-2026-11-16.md §7.1–7.2, step 1).
// Rules are errors so that a new violation fails `npm run lint`; existing ones are frozen in
// eslint-suppressions.json. `npm run lint:prune` drops entries that were fixed; it never admits new ones.
// no-floating-promises and no-misused-promises are type-aware: lint loads the whole tsconfig program
// (about one compile's time and memory), so run it on the Mac build host, not the low-memory dev box.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "artifacts/**", "scripts/**", "docs/**"] },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    // A stale directive for a rule this config does not enable is not a defect; do not report it.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      // node:test's test/describe/it return a promise the runner awaits; an unawaited call there is the idiom.
      "@typescript-eslint/no-floating-promises": ["error", {
        allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it", "suite"] }]
      }],
      "@typescript-eslint/no-misused-promises": "error",
      "no-restricted-syntax": ["error", {
        selector: "TSAsExpression > TSAsExpression.expression[typeAnnotation.type='TSUnknownKeyword']",
        message: "Do not launder types with `as unknown as`; narrow with a type guard or a schema."
      }]
    }
  },
  // Function size and complexity (production code only): existing outliers are frozen like the rules above,
  // so a function that is already over a limit may not get worse and a new one may not cross it.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      complexity: ["error", 25],
      "max-lines-per-function": ["error", { max: 120, skipBlankLines: true, skipComments: true }],
      "max-depth": ["error", 5],
      "max-params": ["error", 6]
    }
  }
);
