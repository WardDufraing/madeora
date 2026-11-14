import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { OraMemories } from "./ora-memories";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const homes = [{ id: HOME_ID, name: "Thuis" }];
const memories = [
  { key: "task-list" as const, homeId: null, listName: "Inbox" },
  { key: "shopping-list" as const, homeId: HOME_ID, listName: "Weekly" },
];
const bodies: unknown[] = [];
let status = 200;

beforeEach(() => {
  bodies.length = 0;
  status = 200;
  navigation.refresh.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null);
      return Promise.resolve(new Response("{}", { status }));
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("What Ora remembers", () => {
  it("lists each remembered choice with where it applies, and has no accessibility violations", async () => {
    const { container } = renderWithQuery(<OraMemories memories={memories} homes={homes} />);
    expect(screen.getByText("New tasks in Personal go to “Inbox”")).toBeInTheDocument();
    expect(screen.getByText("New shopping items in Thuis go to “Weekly”")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("forgets one choice, says so, and keeps focus on the card", async () => {
    const user = userEvent.setup();
    renderWithQuery(<OraMemories memories={memories} homes={homes} />);
    await user.click(screen.getByRole("button", { name: "Forget “Weekly” in Thuis" }));
    await waitFor(() => {
      expect(bodies).toEqual([{ homeId: HOME_ID, key: "shopping-list" }]);
    });
    expect(await screen.findByText("Forgotten. Ora will not use it again.")).toBeInTheDocument();
    expect(screen.queryByText(/Weekly/)).toBeNull();
    expect(screen.getByText("New tasks in Personal go to “Inbox”")).toBeInTheDocument();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  it("says when it could not forget, and when there is nothing or it could not be read", async () => {
    const user = userEvent.setup();
    status = 500;
    const { unmount } = renderWithQuery(<OraMemories memories={memories} homes={homes} />);
    await user.click(screen.getByRole("button", { name: "Forget “Inbox” in Personal" }));
    expect(await screen.findByText("I could not forget that. Try again.")).toBeInTheDocument();
    expect(screen.getByText("New tasks in Personal go to “Inbox”")).toBeInTheDocument();
    unmount();

    const empty = renderWithQuery(<OraMemories memories={[]} homes={homes} />);
    expect(within(empty.container).getByText(/Nothing yet/)).toBeInTheDocument();
    empty.unmount();
    renderWithQuery(<OraMemories memories={[]} homes={homes} unavailable />);
    expect(screen.getByText(/could not read what Ora remembers/)).toBeInTheDocument();
  });
});
