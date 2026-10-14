import { next } from "@madeora/config/eslint/next";

// The boundary fixtures are tiny stand-alone apps built by scripts/check-server-env-boundary.ts;
// one of them is deliberately wrong.
export default [{ ignores: ["test-fixtures/**"] }, ...next];
