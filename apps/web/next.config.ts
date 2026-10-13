import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@madeora/config"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
