import { getPublicEnv } from "@madeora/config/env/public";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@madeora/config", "@madeora/design-tokens", "@madeora/icons"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default function config(phase: string): NextConfig {
  // NEXT_PUBLIC_ values are inlined into the bundle at build time, so check them before building.
  if (phase === PHASE_PRODUCTION_BUILD) {
    getPublicEnv(process.env);
  }
  return nextConfig;
}
