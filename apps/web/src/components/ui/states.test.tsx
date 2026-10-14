import { render, screen } from "@testing-library/react";

import { axeViolations } from "@/test/axe";

import { EmptyState, ErrorState, LoadingState } from "./states";

describe("state components", () => {
  it("LoadingState is a status with a visible label", () => {
    render(<LoadingState label="Loading tasks…" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading tasks…");
    expect(status.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("EmptyState shows its title, description and next step", () => {
    render(
      <EmptyState
        title="No tasks yet"
        description="Add one to get started."
        action={<button type="button">Add task</button>}
      />,
    );
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    expect(screen.getByText("Add one to get started.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add task" })).toBeInTheDocument();
  });

  it("ErrorState is announced only when asked", () => {
    const { rerender } = render(<ErrorState title="Couldn't load tasks" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(
      <ErrorState
        title="Couldn't load tasks"
        announce
        action={<button type="button">Try again</button>}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load tasks");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("have no axe violations", async () => {
    const { container } = render(
      <div>
        <EmptyState title="Empty" />
        <LoadingState label="Loading" />
        <ErrorState title="Error" description="Details" announce />
      </div>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
