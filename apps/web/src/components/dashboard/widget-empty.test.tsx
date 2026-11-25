import { render, screen } from "@testing-library/react";

import { WidgetEmpty } from "./widget-empty";

describe("WidgetEmpty", () => {
  it("shows the full message without a hide marker", () => {
    const { container } = render(<WidgetEmpty mode="full" title="Nothing" description="Detail" />);
    expect(screen.getByText("Detail")).toBeInTheDocument();
    expect(container.querySelector("[data-widget-empty]")).toBeNull();
  });

  it("shows one line for compact, never marked as hidden", () => {
    const { container } = render(
      <WidgetEmpty mode="compact" title="Nothing" description="Detail" />,
    );
    expect(screen.getByText("Nothing")).toBeInTheDocument();
    expect(screen.queryByText("Detail")).not.toBeInTheDocument();
    expect(container.querySelector('[data-widget-empty="compact"]')).not.toBeNull();
    expect(container.querySelector('[data-widget-empty="hide"]')).toBeNull();
  });

  it("marks hide so the grid can hide the widget, keeping the line as a fallback", () => {
    const { container } = render(<WidgetEmpty mode="hide" title="Nothing" />);
    expect(container.querySelector('[data-widget-empty="hide"]')).not.toBeNull();
    expect(screen.getByText("Nothing")).toBeInTheDocument();
  });
});
