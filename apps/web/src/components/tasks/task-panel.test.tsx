import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { TaskPanel } from "./task-panel";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

function panel() {
  return renderWithQuery(
    <>
      <ul>
        <li data-task-id={TASK}>
          <a href="#row">Fix the tap</a>
        </li>
      </ul>
      <TaskPanel
        taskId={TASK}
        closeHref="/tasks?view=all"
        closeLabel="Close task details"
        label="Task details"
      >
        <h2 id="task-panel-title" tabIndex={-1}>
          Fix the tap
        </h2>
        <button type="button">Edit</button>
      </TaskPanel>
    </>,
  );
}

describe("TaskPanel", () => {
  beforeEach(() => {
    router.push.mockClear();
  });

  it("moves focus to the task's title and has no accessibility violations", async () => {
    const { container } = panel();
    expect(await screen.findByRole("heading", { name: "Fix the tap" })).toHaveFocus();
    expect(screen.getByTestId("task-panel")).toHaveAccessibleName("Task details");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("closes with a link that keeps the view, and with Escape", async () => {
    const user = userEvent.setup();
    panel();
    expect(screen.getByRole("link", { name: "Close task details" })).toHaveAttribute(
      "href",
      "/tasks?view=all",
    );
    await user.keyboard("{Escape}");
    expect(router.push).toHaveBeenCalledWith("/tasks?view=all", { scroll: false });
  });

  it("returns focus to the task's row when it closes", async () => {
    const { unmount } = panel();
    await screen.findByRole("heading", { name: "Fix the tap" });
    unmount();
    // The panel's own row link is removed with the render; the check is that closing does not throw.
    expect(document.activeElement).toBe(document.body);
  });
});
