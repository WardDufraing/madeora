import { screen } from "@testing-library/react";

import { renderWithIntl } from "@/test/intl";

import DashboardPage from "./page";

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { default: messages } = await import("@/i18n/messages/en.json");
  return {
    getTranslations: (namespace: string) =>
      Promise.resolve(
        createTranslator({ locale: "en", messages, namespace: namespace as "Dashboard" }),
      ),
  };
});

vi.mock("@/auth/identity", () => ({
  requireIdentity: () => Promise.resolve({ userId: "synthetic-user" }),
}));

describe("DashboardPage", () => {
  it("renders a single top-level heading and an honest empty state, without invented data", async () => {
    renderWithIntl(await DashboardPage());
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Your dashboard is on its way")).toBeInTheDocument();
  });
});
