/**
 * Oxlint configuration for the Harvestlink React + TypeScript frontend.
 * Enforces React hooks rules and TypeScript-aware linting.
 */
export default {
  $schema: "./node_modules/oxlint/configuration_schema.json",
  plugins: ["react", "typescript", "oxc"],
  rules: {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { allowConstantExport: true }],
  },
};
