import { render, screen } from "@testing-library/react";

import { axeViolations } from "@/test/axe";

import { Card } from "./card";

describe("Card", () => {
  it("is a region named by its title heading", () => {
    render(
      <Card title="Tasks" description="4 left" action={<a href="/tasks">View all</a>}>
        <p>Content</p>
      </Card>,
    );

    const region = screen.getByRole("region", { name: "Tasks" });
    expect(screen.getByRole("heading", { level: 2, name: "Tasks" })).toBeInTheDocument();
    expect(region).toHaveTextContent("4 left");
    expect(screen.getByRole("link", { name: "View all" })).toBeInTheDocument();
  });

  it("uses the requested heading level", () => {
    render(<Card title="Nested" headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Nested" })).toBeInTheDocument();
  });

  it("is a plain container without a title", () => {
    render(<Card>Just content</Card>);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.getByText("Just content")).toBeInTheDocument();
  });

  it("has a solid surface, not a gradient", () => {
    const { container } = render(<Card title="Plain" />);
    const classes = container.firstElementChild?.className ?? "";
    expect(classes).toContain("bg-surface");
    expect(classes).not.toMatch(/gradient/);
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <div>
        <Card title="One">A</Card>
        <Card>B</Card>
      </div>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
