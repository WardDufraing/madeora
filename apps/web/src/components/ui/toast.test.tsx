import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, vi } from "vitest";

import { axeViolations } from "@/test/axe";

import { DEFAULT_TOAST_DURATION, ToastProvider, useToast, type ToastOptions } from "./toast";

type ToastApi = ReturnType<typeof useToast>;
let api: ToastApi | undefined;

function Capture({ onApi }: { readonly onApi: (value: ToastApi) => void }) {
  const value = useToast();
  useEffect(() => {
    onApi(value);
  }, [onApi, value]);
  return null;
}

function keepApi(value: ToastApi) {
  api = value;
}

function renderProvider() {
  return render(
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
      <Capture onApi={keepApi} />
    </ToastProvider>,
  );
}

function show(options: ToastOptions): number {
  let id = 0;
  act(() => {
    id = api?.show(options) ?? 0;
  });
  return id;
}

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    api = undefined;
  });

  it("shows a message in a labelled region and announces it politely", () => {
    renderProvider();
    show({ title: "Saved", description: "Your changes are saved.", tone: "success" });

    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region).toHaveTextContent("Saved");
    expect(screen.getByRole("status")).toHaveTextContent("Saved. Your changes are saved.");
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  });

  it("announces errors assertively", () => {
    renderProvider();
    show({ title: "Couldn't save", tone: "error" });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("hides itself after the default duration", () => {
    renderProvider();
    show({ title: "Saved" });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_DURATION - 1);
    });
    expect(screen.getByRole("listitem")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("keeps errors and persistent toasts until dismissed", () => {
    renderProvider();
    show({ title: "Couldn't save", tone: "error" });
    show({ title: "Item deleted", duration: null });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("pauses while hovered or focused and resumes with the time left", () => {
    renderProvider();
    show({ title: "Saved", duration: 1000 });
    const item = screen.getByRole("listitem");

    act(() => {
      vi.advanceTimersByTime(600);
      item.dispatchEvent(new Event("pointerenter"));
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(item).toBeInTheDocument();

    act(() => {
      item.dispatchEvent(new Event("pointerleave"));
      screen.getByRole("button", { name: "Dismiss" }).focus();
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(item).toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: "Dismiss" }).blur();
    });
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(item).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("can be dismissed with its button", async () => {
    renderProvider();
    show({ title: "Saved", duration: null });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("runs its action once and then dismisses itself", async () => {
    const onAction = vi.fn();
    renderProvider();
    show({ title: "Item deleted", action: { label: "Undo", onAction }, duration: null });
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("can be dismissed by id", () => {
    renderProvider();
    const id = show({ title: "One", duration: null });
    show({ title: "Two", duration: null });
    act(() => {
      api?.dismiss(id);
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("listitem")).toHaveTextContent("Two");
  });

  it("refuses to work outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Capture onApi={keepApi} />)).toThrow(
      "useToast must be used inside a ToastProvider.",
    );
  });

  it("has no axe violations with every tone and an action", async () => {
    vi.useRealTimers();
    const { container } = renderProvider();
    for (const tone of ["info", "success", "warning", "error"] as const)
      show({ title: tone, tone, duration: null });
    show({
      title: "Deleted",
      action: { label: "Undo", onAction: () => undefined },
      duration: null,
    });
    expect(await axeViolations(container)).toEqual([]);
  });
});
