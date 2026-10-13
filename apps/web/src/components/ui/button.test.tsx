import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { axeViolations } from "@/test/axe";

import { Button } from "./button";

describe("Button", () => {
  it("is a plain button (not submit) with its label as the accessible name", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "button");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("can be activated from the keyboard", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("stays focusable but ignores clicks and form submission while loading", async () => {
    const onClick = vi.fn();
    const onSubmit = vi.fn();
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Button type="submit" loading onClick={onClick}>
          Saving
        </Button>
      </form>,
    );

    const button = screen.getByRole("button", { name: "Saving" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    await userEvent.tab();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    await userEvent.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    // The spinner is decorative; the label carries the meaning.
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("does not respond when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("uses only token colours: the primary button is drawn with the accent tokens", () => {
    render(<Button>Save</Button>);
    const classes = screen.getByRole("button").className;
    expect(classes).toContain("bg-accent");
    expect(classes).toContain("text-on-accent");
    expect(classes).toContain("hover:bg-accent-hover");
  });

  it("has no axe violations in any variant", async () => {
    const { container } = render(
      <div>
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Delete</Button>
        <Button size="sm">Small</Button>
        <Button loading>Saving</Button>
        <Button disabled>Disabled</Button>
      </div>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
