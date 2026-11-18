import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { createServiceRoleClient, isServiceRoleRpc, SERVICE_ROLE_RPCS } from "./service-role";

const rpc = vi.fn();
const generateLink = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc, auth: { admin: { generateLink } } }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }),
}));

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) && !/\.test\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));
const where = (test: (text: string) => boolean) =>
  files
    .filter((file) => test(file.text))
    .map((file) => file.path)
    .sort();

describe("the service-role allowlist (S15-M3)", () => {
  it("reads the secret key in two places only: child sign-in and the storage settings", () => {
    expect(where((text) => text.includes("SUPABASE_SERVICE_ROLE_KEY"))).toEqual([
      "child-sign-in/service.ts",
      "storage/config.ts",
    ]);
  });

  it("creates a Supabase client from supabase-js only here and for the browser's public key", () => {
    expect(
      where((text) => /from "@supabase\/supabase-js"/.test(text) && /\bcreateClient\b/.test(text)),
    ).toEqual(["auth/service-role.ts", "auth/supabase-browser.ts"]);
    const browser = files.find((file) => file.path === "auth/supabase-browser.ts")?.text ?? "";
    expect(browser).not.toMatch(/SERVICE_ROLE|serviceRole/);
  });

  it("is used by the listed server modules only", () => {
    expect(where((text) => text.includes('from "@/auth/service-role"'))).toEqual([
      "child-sign-in/service.ts",
      "storage/server.ts",
    ]);
    expect(where((text) => /\bhouseholdService\(\)/.test(text))).toEqual([
      "child-sign-in/device-chores.ts",
      "child-sign-in/service.ts",
      "child-transition/service.ts",
      "displays/display-actions.ts",
      "displays/service.ts",
    ]);
  });

  it("calls only listed functions from the modules that hold the client", () => {
    const holders = [
      "child-sign-in/device-chores.ts",
      "child-sign-in/service.ts",
      "child-transition/service.ts",
      "displays/display-actions.ts",
      "displays/service.ts",
      "storage/server.ts",
    ];
    for (const path of holders) {
      const text = files.find((file) => file.path === path)?.text ?? "";
      const called = [...text.matchAll(/(?:client|service)\.rpc\("([a-z_]+)"/g)].map(
        (match) => match[1] ?? "",
      );
      expect(called.length, path).toBeGreaterThan(0);
      for (const name of called) expect(isServiceRoleRpc(name), `${path}: ${name}`).toBe(true);
    }
  });

  it("is read nowhere else in the repository than here and the jobs' own allowlisted runner", () => {
    // Review M-5: every app and package, not only apps/web. The jobs' functions are listed and checked
    // in packages/jobs/src/service-role-allowlist.test.ts.
    const root = join(__dirname, "../../../..");
    const roots = ["apps", "packages"].flatMap((group) =>
      readdirSync(join(root, group))
        .map((name) => join(root, group, name, "src"))
        .filter((dir) => {
          try {
            return statSync(dir).isDirectory();
          } catch {
            return false;
          }
        }),
    );
    const readers = roots
      .flatMap((dir) => sourceFiles(dir))
      .filter((path) => readFileSync(path, "utf8").includes("SUPABASE_SERVICE_ROLE_KEY"))
      .map((path) => relative(root, path).split(sep).join("/"))
      .sort();
    expect(readers).toEqual([
      "apps/web/src/child-sign-in/service.ts",
      "apps/web/src/storage/config.ts",
      "packages/jobs/src/trigger/env.ts",
      "packages/jobs/src/trigger/tasks.ts",
    ]);
  });

  it("refuses any other function at run time, before reaching the database", async () => {
    expect(SERVICE_ROLE_RPCS).toContain("finalize_upload");
    expect(isServiceRoleRpc("delete_account")).toBe(false);
    const client = createServiceRoleClient("sb_secret_abcdefghijklmnopqrstuvwxyz");
    const call = client.rpc.bind(client) as (fn: string, args: unknown) => Promise<unknown>;
    await expect(call("delete_account", {})).rejects.toThrow("not allowed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes a listed call through and reports only the error code", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "secret detail" } });
    const client = createServiceRoleClient("sb_secret_abcdefghijklmnopqrstuvwxyz");
    expect(await client.rpc("display_pairing_status", { p_secret_hash: "x" })).toEqual({
      data: null,
      error: { code: "42501" },
    });
    generateLink.mockResolvedValueOnce({
      data: { properties: { hashed_token: "t" } },
      error: null,
    });
    expect(await client.magicLinkToken("child@alias.invalid")).toEqual({
      tokenHash: "t",
      error: null,
    });
  });
});
