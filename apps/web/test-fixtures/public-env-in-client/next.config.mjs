// Control fixture for scripts/check-server-env-boundary.ts: the same app importing only the
// public environment module. Its build must succeed, which shows the other fixture fails
// because of the server-only import and nothing else.
const config = {
  transpilePackages: ["@madeora/config"],
};

export default config;
