import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { vi } from "vitest";

import { useHydrated } from "./use-hydrated";

function Probe() {
  return <p>{useHydrated() ? "hydrated" : "server"}</p>;
}

describe("useHydrated", () => {
  it("is false in the server render and turns true after hydration, without a mismatch", async () => {
    const html = renderToString(<Probe />);
    expect(html).toContain("server");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recoverable = vi.fn();

    try {
      const root = await act(() =>
        hydrateRoot(container, <Probe />, { onRecoverableError: recoverable }),
      );
      expect(container.textContent).toBe("hydrated");
      expect(recoverable).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      act(() => {
        root.unmount();
      });
    } finally {
      container.remove();
      consoleError.mockRestore();
    }
  });
});
