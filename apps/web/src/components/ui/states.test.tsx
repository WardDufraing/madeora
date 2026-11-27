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

  it("EmptyState is a soft solid card, not a dashed outline", () => {
    render(<EmptyState title="No tasks yet" />);
    const card = screen.getByText("No tasks yet").parentElement;
    expect(card).toHaveClass("rounded-card", "bg-page");
    expect(card).not.toHaveClass("border-dashed");
  });

  it("EmptyState and ErrorState show a decorative icon medallion, with different shapes", () => {
    const { container: empty } = render(<EmptyState title="No tasks yet" />);
    const { container: failed } = render(<ErrorState title="Couldn't load tasks" />);

    const emptyIcon = empty.querySelector("svg");
    const errorIcon = failed.querySelector("svg");
    expect(emptyIcon).toHaveAttribute("aria-hidden", "true");
    expect(errorIcon).toHaveAttribute("aria-hidden", "true");
    // Two different icon shapes, so the states are not told apart by colour alone.
    expect(emptyIcon?.innerHTML).not.toBe(errorIcon?.innerHTML);
    expect(emptyIcon?.parentElement).toHaveClass("rounded-pill", "bg-accent-subtle");
    expect(errorIcon?.parentElement).toHaveClass("rounded-pill", "bg-danger-subtle");
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
