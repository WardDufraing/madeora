import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";

import { Popover } from "./popover";

function setup() {
  return render(
    <>
      <Popover label="Widget settings" trigger="Settings">
        {(close) => (
          <>
            <label>
              Show completed
              <input type="checkbox" />
            </label>
            <button type="button" onClick={close}>
              Done
            </button>
          </>
        )}
      </Popover>
      <button type="button">Outside</button>
    </>,
  );
}

describe("Popover", () => {
  it("is closed until the trigger is pressed, and reports its state", async () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Widget settings" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Widget settings" })).toBeInTheDocument();
  });

  it("moves focus into the panel and returns it to the trigger on Escape", async () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Widget settings" });
    await userEvent.click(trigger);
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on a press outside without moving focus back", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Widget settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
  });

  it("lets its content close it and returns focus to the trigger", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Widget settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Widget settings" })).toHaveFocus();
  });

  it("has no accessibility violations open", async () => {
    const { container } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Widget settings" }));
    expect(await axeViolations(container)).toEqual([]);
  });
});
