import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { OraCelebrationNote } from "./ora-celebration";
import { OraWhy } from "./ora-why";

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const answers: unknown[] = [];
const bodies: unknown[] = [];

beforeEach(() => {
  window.sessionStorage.clear();
  answers.length = 0;
  bodies.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null);
      const next = answers.shift() ?? { celebration: null };
      return Promise.resolve(Response.json(next));
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const note = (props: { homeId?: string | null; hidden?: boolean } = {}) => (
  <OraCelebrationNote
    homeId={props.homeId === undefined ? HOME_ID : props.homeId}
    hidden={props.hidden ?? false}
    palette="heather"
    motion="gentle"
  />
);

describe("Ora celebration note", () => {
  it("shows a short, dismissible note for one awarded chore, without taking focus", async () => {
    const user = userEvent.setup();
    answers.push({ celebration: { count: 1, points: 5, title: "Dishes" } });
    const { container } = renderWithIntl(note());
    const status = await screen.findByTestId("ora-celebration");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("5 points for “Dishes”. Nicely done!");
    expect(bodies).toEqual([{ homeId: HOME_ID }]);
    expect(document.body).toHaveFocus();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Thanks" }));
    expect(screen.queryByTestId("ora-celebration")).toBeNull();
  });

  it("groups several awards into one line that names no chore", async () => {
    answers.push({ celebration: { count: 3, points: 11, title: null } });
    renderWithIntl(note());
    expect(await screen.findByTestId("ora-celebration")).toHaveTextContent(
      "3 chores done and 11 points earned. Nicely done!",
    );
  });

  it("keeps a celebration that arrives while Ora is open (the claim is already committed)", async () => {
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => {
              resolve(Response.json({ celebration: { count: 2, points: 3, title: null } }));
            };
          }),
      ),
    );
    function Harness() {
      const [hidden, setHidden] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setHidden((value) => !value);
            }}
          >
            toggle
          </button>
          {note({ hidden })}
        </>
      );
    }
    const user = userEvent.setup();
    renderWithIntl(<Harness />);
    await user.click(screen.getByRole("button", { name: "toggle" }));
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("ora-celebration")).toBeNull();
    await user.click(screen.getByRole("button", { name: "toggle" }));
    expect(await screen.findByTestId("ora-celebration")).toHaveTextContent("2 chores done");
  });

  it("uses singular copy for one award without a name", async () => {
    answers.push({ celebration: { count: 1, points: 1, title: null } });
    renderWithIntl(note());
    expect(await screen.findByTestId("ora-celebration")).toHaveTextContent(
      "1 chore done and 1 point earned",
    );
  });

  it("steps away by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answers.push({ celebration: { count: 1, points: 1, title: "Bins" } });
    renderWithIntl(note());
    expect(await screen.findByTestId("ora-celebration")).toBeInTheDocument();
    // Let the effect that starts the 15-second timer run first (under load it can lag the render).
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(screen.queryByTestId("ora-celebration")).toBeNull();
  });

  it("does not ask again within a minute in the same tab, however often the page loads", async () => {
    const first = renderWithIntl(note());
    await act(() => Promise.resolve());
    first.unmount();
    renderWithIntl(note());
    await act(() => Promise.resolve());
    expect(bodies).toHaveLength(1);
    window.sessionStorage.clear();
    renderWithIntl(note());
    await act(() => Promise.resolve());
    expect(bodies).toHaveLength(2);
  });

  it("asks nothing in Personal space, and nothing while Ora is open", () => {
    renderWithIntl(note({ homeId: null }));
    renderWithIntl(note({ hidden: true }));
    expect(bodies).toEqual([]);
    expect(screen.queryByTestId("ora-celebration")).toBeNull();
  });

  it("stays quiet when there is nothing to celebrate or the call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    renderWithIntl(note());
    await act(() => Promise.resolve());
    expect(screen.queryByTestId("ora-celebration")).toBeNull();
  });
});

describe("Why am I seeing this?", () => {
  it("explains a suggestion only on request, and says where to switch it off", async () => {
    const user = userEvent.setup();
    renderWithIntl(<OraWhy />);
    expect(screen.queryByText(/Ora settings/)).toBeNull();
    const button = screen.getByRole("button", { name: "Why am I seeing this?" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/switch suggestions off in Ora settings/)).toBeInTheDocument();
  });
});
