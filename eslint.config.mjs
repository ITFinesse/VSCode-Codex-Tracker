import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["out/**", "lean-ctx-main/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["src/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "error", "@typescript-eslint/no-unused-vars": "off" } }
];
