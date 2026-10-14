import { screen } from "@testing-library/react";

import { renderWithIntl } from "@/test/intl";

import { HomePlaceholder } from "./home-placeholder";

describe("HomePlaceholder", () => {
  it("says honestly that Homes are not built yet and leads back to the dashboard", () => {
    renderWithIntl(<HomePlaceholder title="Create a Home" description="Not here yet." />);
    expect(screen.getByRole("heading", { level: 1, name: "Create a Home" })).toBeInTheDocument();
    expect(screen.getByText("Not built yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to your dashboard" })).toHaveAttribute(
      "href",
      "/",
    );
  });
});
