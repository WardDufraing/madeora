import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { vi } from "vitest";

import { axeViolations } from "@/test/axe";

import { CreateDialog } from "./create-dialog";

const discardPrompt = {
  title: "Discard changes?",
  message: "Your input will be lost.",
  discard: "Discard",
  keep: "Keep editing",
};

function Harness({
  onSubmit = vi.fn(),
  submitting = false,
  error,
}: {
  readonly onSubmit?: () => void;
  readonly submitting?: boolean;
  readonly error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        + New Task
      </button>
      <CreateDialog
        open={open}
        onClose={() => {
          setOpen(false);
          setValue("");
        }}
        title="New task"
        closeLabel="Close"
        submitLabel="Save"
        cancelLabel="Cancel"
        onSubmit={onSubmit}
        submitting={submitting}
        dirty={value !== ""}
        discardPrompt={discardPrompt}
        {...(error !== undefined && { error })}
      >
        <label>
          Title
          <input
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </label>
      </CreateDialog>
    </>
  );
}

async function openDialog() {
  await userEvent.click(screen.getByRole("button", { name: "+ New Task" }));
}

describe("CreateDialog", () => {
  it("puts Cancel before Save and submits with Enter", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await openDialog();
    const buttons = screen.getAllByRole("button").map((button) => button.textContent);
    expect(buttons.indexOf("Cancel")).toBeLessThan(buttons.indexOf("Save"));

    await userEvent.type(screen.getByLabelText("Title"), "Buy milk{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("closes without a question when nothing changed, returning focus to the trigger", async () => {
    render(<Harness />);
    await openDialog();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ New Task" })).toHaveFocus();
  });

  it("asks before discarding input, and keeps editing when told to", async () => {
    render(<Harness />);
    await openDialog();
    await userEvent.type(screen.getByLabelText("Title"), "Buy milk");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("alertdialog", { name: "Discard changes?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Buy milk");
  });

  it("discards input only after confirmation", async () => {
    render(<Harness />);
    await openDialog();
    await userEvent.type(screen.getByLabelText("Title"), "Buy milk");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores a second submit while saving and shows a form error", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} submitting error="Could not save" />);
    await openDialog();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<Harness />);
    await openDialog();
    expect(await axeViolations(container)).toEqual([]);
  });
});
