// Runs once when the Next.js server starts: fail fast on missing or invalid configuration.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { validateStartupEnv } = await import("./env/validate");
  validateStartupEnv(process.env);
}
