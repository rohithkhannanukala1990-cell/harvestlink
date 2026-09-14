/**
 * ESLint flat config for the Harvestlink backend.
 * Enforces TypeScript best practices and defers formatting to Prettier.
 */
import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
);
