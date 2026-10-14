import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";

import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
  it("toggles from its label, the box and the keyboard", async () => {
    render(<Checkbox label="Water plants" />);

    const checkbox = screen.getByRole("checkbox", { name: "Water plants" });
    expect(checkbox).not.toBeChecked();
    await userEvent.click(screen.getByText("Water plants"));
    expect(checkbox).toBeChecked();
    await userEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    checkbox.blur();
    await userEvent.tab();
    expect(checkbox).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(checkbox).toBeChecked();
  });

  it("shows a check mark for the checked state, hidden from screen readers", () => {
    const { container } = render(<Checkbox label="Done" defaultChecked />);
    const mark = container.querySelector("svg");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark?.getAttribute("class")).toContain("peer-checked:block");
  });

  it("links its description and error and marks it invalid", () => {
    render(
      <Checkbox label="Agree" description="Required to continue." error="Please confirm this." />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Agree" });
    expect(checkbox).toHaveAccessibleDescription("Required to continue. Please confirm this.");
    expect(checkbox).toHaveAttribute("aria-invalid", "true");
  });

  it("cannot be changed when disabled", async () => {
    render(<Checkbox label="Locked" disabled />);
    const checkbox = screen.getByRole("checkbox", { name: "Locked" });
    await userEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <div>
        <Checkbox label="Unchecked" />
        <Checkbox label="Checked" defaultChecked />
        <Checkbox label="Invalid" error="Wrong" />
        <Checkbox label="Disabled" disabled />
      </div>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
