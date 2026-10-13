import { render, screen } from "@testing-library/react";
import { afterEach, vi } from "vitest";

vi.mock("next/server", () => ({ connection: vi.fn(() => Promise.resolve()) }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadPage() {
  const page = await import("./page");
  return page.default;
}

describe("component preview page", () => {
  it("is not served in production", async () => {
    vi.stubEnv("APP_ENV", "production");
    const Page = await loadPage();
    await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each(["development", "test", "preview", "staging"])("renders in %s", async (environment) => {
    vi.stubEnv("APP_ENV", environment);
    const Page = await loadPage();
    render(await Page());
    expect(
      screen.getByRole("heading", { level: 1, name: "Component preview" }),
    ).toBeInTheDocument();
  });
});
