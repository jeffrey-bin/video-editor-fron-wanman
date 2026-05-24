import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: [".next/**", "**/.next/**", ".ms-playwright/**", "**/.ms-playwright/**", "coverage/**", "node_modules/**", "test-results/**", ".promptcut-runtime/**", "next-env.d.ts"],
  },
  js.configs.recommended,
  {
    files: ["tests/fixtures/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        Buffer: "readonly",
        console: "readonly",
        File: "readonly",
        FormData: "readonly",
        NodeJS: "readonly",
        process: "readonly",
        React: "readonly",
        Request: "readonly",
        Response: "readonly",
        setTimeout: "readonly",
        structuredClone: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "off",
    },
  },
];
