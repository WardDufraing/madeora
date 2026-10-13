// ESLint flat config for Next.js apps: base rules plus React, React Hooks, Next.js and accessibility.
import nextPlugin from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

import { base } from "./base.js";

/** @type {import("typescript-eslint").ConfigArray} */
export const next = tseslint.config(
  ...base,
  {
    files: ["**/*.{ts,tsx}"],
    ...react.configs.flat.recommended,
    settings: { react: { version: "detect" } },
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    ...react.configs.flat["jsx-runtime"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    ...reactHooks.configs.flat["recommended-latest"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    ...jsxA11y.flatConfigs.strict,
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
);

export default next;
