import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";

import { useAnnouncer } from "./use-announcer";

const sayRef: { current: (message: string) => void } = { current: () => undefined };

function Harness({ onReady }: { readonly onReady: (announce: (message: string) => void) => void }) {
  const { announce, region } = useAnnouncer();
  useEffect(() => {
    onReady(announce);
  }, [announce, onReady]);
  return region;
}

const ready = (announce: (message: string) => void) => {
  sayRef.current = announce;
};
const say = (message: string) => {
  sayRef.current(message);
};

describe("useAnnouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a polite status region", () => {
    render(<Harness onReady={ready} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("announces the same words a second time by emptying the region first (S17 L5)", () => {
    render(<Harness onReady={ready} />);
    const region = screen.getByTestId("live-region");
    act(() => {
      say("Fit it done.");
    });
    expect(region).toBeEmptyDOMElement();
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(region).toHaveTextContent("Fit it done.");
    act(() => {
      say("Fit it done.");
    });
    expect(region).toBeEmptyDOMElement();
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(region).toHaveTextContent("Fit it done.");
  });

  it("keeps only the latest message when two come quickly", () => {
    render(<Harness onReady={ready} />);
    act(() => {
      say("First.");
      say("Second.");
      vi.advanceTimersByTime(60);
    });
    expect(screen.getByTestId("live-region")).toHaveTextContent("Second.");
  });
});
