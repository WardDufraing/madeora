import { screen } from "@testing-library/react";

import { renderWithIntl } from "@/test/intl";

import DashboardPage from "./page";

describe("DashboardPage", () => {
  it("renders a single top-level heading and an honest empty state, without invented data", () => {
    renderWithIntl(<DashboardPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Your dashboard is on its way")).toBeInTheDocument();
  });
});
