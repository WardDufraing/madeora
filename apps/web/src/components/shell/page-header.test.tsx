import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("shows the title as the page heading with the sub-line under it", () => {
    render(<PageHeader title="Calendar" subtitle="Personal" />);
    expect(screen.getByRole("heading", { level: 1, name: "Calendar" })).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
  });

  it("puts the actions in the same row as the title", () => {
    render(<PageHeader title="Tasks" actions={<button type="button">New task</button>} />);
    const heading = screen.getByRole("heading", { name: "Tasks" });
    const action = screen.getByRole("button", { name: "New task" });
    expect(heading.closest("div")?.parentElement).toBe(action.parentElement?.parentElement);
  });

  it("renders no empty action area without actions", () => {
    const { container } = render(<PageHeader title="Tasks" />);
    expect(container.querySelectorAll("div")).toHaveLength(2);
  });
});
