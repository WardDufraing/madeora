import { emailLinkTarget } from "./email-links";

vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora-git-main-owner.vercel.app" }),
}));

describe("emailLinkTarget", () => {
  it("always uses the configured app address", () => {
    expect(emailLinkTarget("/auth/confirm")).toBe(
      "https://madeora-git-main-owner.vercel.app/auth/confirm",
    );
    expect(emailLinkTarget("/reset-password")).toBe(
      "https://madeora-git-main-owner.vercel.app/reset-password",
    );
  });
});
