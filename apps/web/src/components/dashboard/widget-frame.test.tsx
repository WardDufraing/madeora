import { render, screen } from "@testing-library/react";

import { WidgetFrame } from "./dashboard-grid";

describe("WidgetFrame", () => {
  it("names the article after the widget and shows its title as a level 2 heading", () => {
    render(
      <WidgetFrame widget={{ title: "Tasks", unavailable: false }}>
        <p>Body</p>
      </WidgetFrame>,
    );
    expect(screen.getByRole("article", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByText("Body")).toBeInTheDocument();
  });
});
