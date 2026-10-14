import { getPublicEnv } from "@madeora/config/env/public";
import { applyVercelPreviewDefaults } from "@madeora/config/env/vercel";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import createNextIntlPlugin from "next-intl/plugin";

// Locale and messages are resolved per request in src/i18n/request.ts.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@madeora/config", "@madeora/design-tokens", "@madeora/icons"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default function config(phase: string): NextConfig {
  // Vercel previews have no fixed web address; fill it in before Next.js inlines it (previews only).
  applyVercelPreviewDefaults(process.env);

  // NEXT_PUBLIC_ values are inlined into the bundle at build time, so check them before building.
  if (phase === PHASE_PRODUCTION_BUILD) {
    getPublicEnv(process.env);
  }
  return withNextIntl(nextConfig);
}
