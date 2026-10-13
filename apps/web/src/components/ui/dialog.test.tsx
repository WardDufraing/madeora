import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { vi } from "vitest";

import { axeViolations } from "@/test/axe";

import { Dialog } from "./dialog";

function Harness({ onClose }: { readonly onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Delete list"
        description="This moves the list to the trash."
        closeLabel="Close"
        footer={<button type="button">Confirm</button>}
      >
        <p>Body</p>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("is hidden until opened", () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens as a named, described dialog and moves focus into it", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    const dialog = screen.getByRole("dialog", { name: "Delete list" });
    expect(dialog).toHaveAccessibleDescription("This moves the list to the trash.");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("closes from the close button and returns focus to the opener", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open" });
    await userEvent.click(opener);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("asks its owner to close on Escape (the browser's cancel event)", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    const cancel = new Event("cancel", { cancelable: true });
    act(() => {
      screen.getByRole("dialog").dispatchEvent(cancel);
    });
    // The component, not the browser, closes it, so `open` stays the single source of truth.
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("tells its owner when the browser closes it by itself", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    act(() => {
      screen.getByRole<HTMLDialogElement>("dialog").close();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when its owner closes it", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open onClose={onClose} title="T" closeLabel="Close">
        x
      </Dialog>,
    );
    rerender(
      <Dialog open={false} onClose={onClose} title="T" closeLabel="Close">
        x
      </Dialog>,
    );
    fireEvent.click(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus after closing a dialog that was mounted open, also in StrictMode", async () => {
    function MountedOpen() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog
          open={open}
          onClose={() => {
            setOpen(false);
          }}
          title="Mounted open"
          closeLabel="Close"
        />
      );
    }
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    render(
      <StrictMode>
        <MountedOpen />
      </StrictMode>,
    );
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("returns focus to the opener when unmounted while open", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <Dialog open onClose={() => undefined} title="Unmounted" closeLabel="Close" />,
    );
    expect(opener).not.toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("has no axe violations when open", async () => {
    const { container } = render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await axeViolations(container)).toEqual([]);
  });
});
