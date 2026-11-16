// Lint gate for src (docs/code-quality-audit-2026-11-16.md §7.1–7.2, step 1).
// Rules are errors so that a new violation fails `npm run lint`; existing ones are frozen in
// eslint-suppressions.json. `npm run lint:prune` drops entries that were fixed; it never admits new ones.
// Type-aware rules (no-floating-promises, no-misused-promises) are left for a later step: they need
// a full TypeScript program, which only the Mac build host can afford.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "artifacts/**", "scripts/**", "docs/**"] },
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    // A stale directive for a rule this config does not enable is not a defect; do not report it.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-restricted-syntax": ["error", {
        selector: "TSAsExpression > TSAsExpression.expression[typeAnnotation.type='TSUnknownKeyword']",
        message: "Do not launder types with `as unknown as`; narrow with a type guard or a schema."
      }]
    }
  }
);
