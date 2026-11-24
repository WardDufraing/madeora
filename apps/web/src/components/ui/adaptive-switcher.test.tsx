import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { vi } from "vitest";

import { axeViolations } from "@/test/axe";

import { AdaptiveSwitcher, type SwitcherItem } from "./adaptive-switcher";

const labels = {
  label: "Task lists",
  searchLabel: "Search lists",
  noResultsLabel: "No lists found",
  pickerLabel: "Choose list",
  createLabel: "New list",
};

function items(count: number): SwitcherItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `list-${String(index)}`,
    label: `List ${String(index)}`,
  }));
}

function Harness({
  count,
  onCreate,
  chipLimit,
}: {
  readonly count: number;
  readonly onCreate?: () => void;
  readonly chipLimit?: number;
}) {
  const [value, setValue] = useState("list-0");
  return (
    <AdaptiveSwitcher
      {...labels}
      items={items(count)}
      value={value}
      onChange={setValue}
      {...(onCreate && { onCreate })}
      {...(chipLimit !== undefined && { chipLimit })}
    />
  );
}

describe("AdaptiveSwitcher", () => {
  it("shows a few items as chips and marks the selected one without relying on colour", async () => {
    render(<Harness count={3} />);
    const group = screen.getByRole("group", { name: "Task lists" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "List 0" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "List 2" }));
    expect(screen.getByRole("button", { name: "List 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "List 0" })).toHaveAttribute("aria-pressed", "false");
  });

  it("offers + New list next to the chips", async () => {
    const onCreate = vi.fn();
    render(<Harness count={2} onCreate={onCreate} />);
    await userEvent.click(screen.getByRole("button", { name: "New list" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("switches to a searchable picker beyond the chip limit", async () => {
    const onCreate = vi.fn();
    render(<Harness count={12} onCreate={onCreate} />);
    expect(screen.queryByRole("group", { name: "Task lists" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Choose list" }));
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);

    await userEvent.type(screen.getByRole("searchbox", { name: "Search lists" }), "List 11");
    expect(screen.getByRole("button", { name: "List 11" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "List 3" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "List 11" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose list" })).toHaveTextContent("List 11");

    // + New list stays available in picker mode.
    expect(screen.getByRole("button", { name: "New list" })).toBeInTheDocument();
  });

  it("says when the search finds nothing", async () => {
    render(<Harness count={9} />);
    await userEvent.click(screen.getByRole("button", { name: "Choose list" }));
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByRole("status")).toHaveTextContent("No lists found");
  });

  it("has no accessibility violations in chip and picker modes", async () => {
    const chips = render(<Harness count={3} onCreate={vi.fn()} />);
    expect(await axeViolations(chips.container)).toEqual([]);
    chips.unmount();

    const picker = render(<Harness count={9} />);
    await userEvent.click(screen.getByRole("button", { name: "Choose list" }));
    expect(await axeViolations(picker.container)).toEqual([]);
  });
});
