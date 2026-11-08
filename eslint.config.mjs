import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
export default tseslint.config(
  { ignores: ["main.js", "node_modules/**", "*.mjs", "version-bump.mjs"] },
  ...obsidianmd.configs.recommended,
  { files: ["src/**/*.ts"], languageOptions: { parser: tseslint.parser, parserOptions: { project: "./tsconfig.json" }, globals: { ...globals.browser } } },
);
