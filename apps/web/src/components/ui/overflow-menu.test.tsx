import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { axeViolations } from "@/test/axe";

import { OverflowMenu } from "./overflow-menu";

function setup(onRemove = vi.fn()) {
  const onConfigure = vi.fn();
  render(
    <OverflowMenu
      label="Widget actions: Tasks"
      items={[
        { id: "configure", label: "Configure", onSelect: onConfigure },
        { id: "locked", label: "Resize", onSelect: vi.fn(), disabled: true },
        { id: "remove", label: "Remove", onSelect: onRemove, destructive: true },
      ]}
    />,
  );
  return { onConfigure, onRemove };
}

describe("OverflowMenu", () => {
  it("opens a named menu and focuses the first enabled item", async () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Widget actions: Tasks" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await userEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Widget actions: Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Configure" })).toHaveFocus();
  });

  it("moves with arrow keys, skips disabled items and wraps", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Widget actions: Tasks" }));
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Configure" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "Configure" })).toHaveFocus();
  });

  it("selects an item, closes and returns focus to the button", async () => {
    const { onConfigure } = setup();
    const trigger = screen.getByRole("button", { name: "Widget actions: Tasks" });
    await userEvent.click(trigger);
    await userEvent.keyboard("{Enter}");
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("does not run disabled items", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Widget actions: Tasks" }));
    expect(screen.getByRole("menuitem", { name: "Resize" })).toBeDisabled();
  });

  it("closes on Escape with focus back on the button", async () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Widget actions: Tasks" });
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("opens from the keyboard with the arrow keys", async () => {
    setup();
    screen.getByRole("button", { name: "Widget actions: Tasks" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("has no accessibility violations open", async () => {
    const { container } = render(
      <OverflowMenu label="Actions" items={[{ id: "a", label: "A", onSelect: vi.fn() }]} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(await axeViolations(container)).toEqual([]);
  });
});
