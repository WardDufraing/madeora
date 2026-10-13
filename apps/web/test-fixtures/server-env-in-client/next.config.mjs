// Fixture for scripts/check-server-env-boundary.ts: a minimal app whose Client Component imports
// the server-only environment module. Its build must fail.
const config = {
  transpilePackages: ["@madeora/config"],
};

export default config;
