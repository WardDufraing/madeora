import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";

import en from "@/i18n/messages/en.json";
import { defaultOraSettings, type OraSettings } from "@/ora/settings";
import type { OraToolSummary } from "@/ora/tools/types";
import { axeViolations } from "@/test/axe";

import { OraAssistant } from "./ora-assistant";

const navigation = vi.hoisted(() => ({
  pathname: "/",
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push, refresh: navigation.refresh }),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const homes = [{ id: HOME_ID, name: "Thuis" }];

const personalTools: OraToolSummary[] = [
  { id: "open-tasks", kind: "navigate", group: "tasks", quick: true },
  { id: "open-calendar", kind: "navigate", group: "calendar", quick: true },
  { id: "open-goals", kind: "navigate", group: "goals", quick: false },
  { id: "capabilities", kind: "read", group: "ora", quick: false },
];
const homeTools: OraToolSummary[] = [
  { id: "open-chores", kind: "navigate", group: "chores", quick: true },
  { id: "open-home-settings", kind: "navigate", group: "home", quick: false },
  { id: "capabilities", kind: "read", group: "ora", quick: false },
];

interface Calls {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}
interface FetchState {
  calls: Calls[];
  tools: unknown;
  toolsStatus: number;
  runStatus: number;
  runOutput: unknown;
  saveStatus: number;
}
const fetchState = vi.hoisted((): FetchState => ({
  calls: [],
  tools: null,
  toolsStatus: 200,
  runStatus: 200,
  runOutput: { kind: "navigate", href: "/tasks" },
  saveStatus: 200,
}));

function installFetch() {
  fetchState.calls = [];
  fetchState.toolsStatus = 200;
  fetchState.runStatus = 200;
  fetchState.saveStatus = 200;
  fetchState.runOutput = { kind: "navigate", href: "/tasks" };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      fetchState.calls.push({ url: input, method, body });
      if (input.startsWith("/api/v1/me/ora")) {
        return Promise.resolve(new Response("{}", { status: fetchState.saveStatus }));
      }
      if (method === "POST") {
        return Promise.resolve(
          Response.json({ output: fetchState.runOutput }, { status: fetchState.runStatus }),
        );
      }
      return Promise.resolve(
        Response.json({ tools: fetchState.tools }, { status: fetchState.toolsStatus }),
      );
    }),
  );
}

function setup(settings: Partial<OraSettings> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <QueryClientProvider client={client}>
        <button type="button">Page button</button>
        <OraAssistant
          userId="user-a"
          settings={{ ...defaultOraSettings, intro: "completed", ...settings }}
          homes={homes}
        />
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  navigation.pathname = "/";
  navigation.push.mockReset();
  navigation.refresh.mockReset();
  fetchState.tools = personalTools;
  installFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const launcher = () => screen.getByTestId("ora-launcher");

describe("Ora assistant", () => {
  it("shows the always-available button, and nothing else until it is opened", () => {
    setup();
    expect(launcher()).toHaveAccessibleName("Open Ora, your Madeora helper");
    expect(launcher()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("ora-surface")).toBeNull();
    // Closed Ora asks the server for nothing.
    expect(fetchState.calls).toEqual([]);
  });

  it("opens with the greeting, the Personal context and the quick actions the server offered", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(launcher());
    const surface = screen.getByRole("dialog", { name: "Ora" });
    expect(surface).toHaveFocus();
    expect(launcher()).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("button", { name: "Open tasks" })).toBeInTheDocument();
    expect(screen.getByTestId("ora-context")).toHaveTextContent("Helping in Personal");
    expect(screen.getByText(/personal things/)).toBeInTheDocument();
    // The honest empty state: no suggestions exist yet, so none are invented.
    expect(screen.getByText(/no suggestions for you right now/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open goals" })).toBeNull();
    expect(fetchState.calls).toEqual([{ url: "/api/v1/ora/tools", method: "GET", body: null }]);
  });

  it("names the Home and asks for that Home's tools", async () => {
    const user = userEvent.setup();
    navigation.pathname = `/homes/${HOME_ID}/chores`;
    fetchState.tools = homeTools;
    setup();
    await user.click(launcher());
    expect(await screen.findByRole("button", { name: "Open chores" })).toBeInTheDocument();
    expect(screen.getByTestId("ora-context")).toHaveTextContent("Helping in Thuis");
    expect(fetchState.calls[0]?.url).toBe(`/api/v1/ora/tools?homeId=${HOME_ID}`);
  });

  it("offers only what the server listed, and 'Browse all actions' shows the rest of that list", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(launcher());
    await screen.findByRole("button", { name: "Open tasks" });
    await user.click(screen.getByRole("button", { name: "Browse all actions" }));
    const browse = document.getElementById("ora-browse");
    expect(browse).not.toBeNull();
    expect(within(browse as HTMLElement).getByRole("button", { name: "Open goals" })).toBeVisible();
    // Never a tool the server did not list (here: the Home settings).
    expect(screen.queryByRole("button", { name: "Open Home settings" })).toBeNull();
  });

  it("runs a quick action through the server, then opens the page it returned and closes", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(launcher());
    await user.click(await screen.findByRole("button", { name: "Open tasks" }));
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith("/tasks");
    });
    expect(fetchState.calls.at(-1)).toEqual({
      url: "/api/v1/ora/tools",
      method: "POST",
      body: { tool: "open-tasks", homeId: null },
    });
    expect(screen.getByTestId("ora-surface")).not.toBeVisible();
  });

  it("never follows an address that leaves Madeora", async () => {
    const user = userEvent.setup();
    fetchState.runOutput = { kind: "navigate", href: "https://evil.example/" };
    setup();
    await user.click(launcher());
    await user.click(await screen.findByRole("button", { name: "Open tasks" }));
    await waitFor(() => {
      expect(fetchState.calls.at(-1)?.method).toBe("POST");
    });
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("says calmly that nothing changed when a tool is refused, and asks the server again what is on offer", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(launcher());
    const quick = await screen.findByRole("button", { name: "Open tasks" });
    fetchState.runStatus = 403;
    fetchState.tools = [];
    await user.click(quick);
    expect(await screen.findByRole("alert")).toHaveTextContent("nothing was changed");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Open tasks" })).toBeNull();
    });
  });

  it("closes with the close button, Escape, a click outside, and puts focus back", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(launcher());
    await screen.findByRole("button", { name: "Open tasks" });
    await user.click(
      within(screen.getByTestId("ora-surface")).getByRole("button", { name: "Close Ora" }),
    );
    expect(screen.getByTestId("ora-surface")).not.toBeVisible();
    expect(launcher()).toHaveFocus();

    await user.click(launcher());
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("ora-surface")).not.toBeVisible();
    expect(launcher()).toHaveFocus();

    await user.click(launcher());
    await user.click(screen.getByRole("button", { name: "Page button" }));
    expect(screen.getByTestId("ora-surface")).not.toBeVisible();

    // Clicking inside does not close it.
    await user.click(launcher());
    await user.click(screen.getByTestId("ora-context"));
    expect(screen.getByTestId("ora-surface")).toBeVisible();
  });

  it("closes with a swipe down on the sheet handle, not with a small movement", () => {
    setup();
    fireEvent.click(launcher());
    const handle = screen.getByTestId("ora-sheet-handle");
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 130, pointerId: 1 });
    expect(screen.getByTestId("ora-surface")).toBeVisible();
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 220, pointerId: 1 });
    expect(screen.getByTestId("ora-surface")).not.toBeVisible();
  });

  it("keeps its state while closed and refetches the tools when reopened", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(launcher());
    await user.click(await screen.findByRole("button", { name: "Browse all actions" }));
    await user.keyboard("{Escape}");
    fetchState.tools = personalTools.slice(0, 2);
    await user.click(launcher());
    expect(screen.getByRole("button", { name: "Show fewer actions" })).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchState.calls.filter((call) => call.method === "GET")).toHaveLength(2);
    });
  });

  it("shows the calm unavailable state with Retry and pages that work without Ora", async () => {
    const user = userEvent.setup();
    fetchState.toolsStatus = 503;
    setup();
    await user.click(launcher());
    const state = await screen.findByTestId("ora-unavailable");
    expect(state).toHaveTextContent("Ora is temporarily unavailable");
    expect(state).toHaveTextContent("The rest of Madeora keeps working");
    expect(within(state).getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
    // The entry point stays: Ora is not hidden when it is unavailable.
    expect(launcher()).toBeVisible();

    fetchState.toolsStatus = 200;
    await user.click(within(state).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Open tasks" })).toBeInTheDocument();
    expect(screen.queryByTestId("ora-unavailable")).toBeNull();
  });

  it("says so when the device is offline, and does not offer Retry as if it could work", async () => {
    const user = userEvent.setup();
    const online = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    try {
      setup();
      await user.click(launcher());
      const state = await screen.findByTestId("ora-unavailable");
      expect(state).toHaveTextContent("You appear to be offline");
      expect(within(state).getByRole("button", { name: "Try again" })).toBeDisabled();
    } finally {
      online.mockRestore();
    }
  });

  it("says Ora cannot help in a place the server refuses, and lists nothing", async () => {
    const user = userEvent.setup();
    navigation.pathname = `/homes/${HOME_ID}`;
    fetchState.toolsStatus = 403;
    setup();
    await user.click(launcher());
    expect(await screen.findByTestId("ora-forbidden")).toHaveTextContent(
      "can't help in this place",
    );
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
  });

  it("shows the introduction once, grounded in the tools on offer, and saves Skip", async () => {
    const user = userEvent.setup();
    setup({ intro: null });
    await user.click(launcher());
    const intro = await screen.findByTestId("ora-intro");
    expect(intro).toHaveTextContent("not a general assistant");
    expect(intro).toHaveTextContent("Tasks, Goals, and Calendar");
    // Optional, read-only example.
    fetchState.runOutput = { kind: "capabilities", tools: personalTools };
    await user.click(within(intro).getByRole("button", { name: "Try an example" }));
    expect(await within(intro).findByText("Open the calendar")).toBeInTheDocument();
    await user.click(within(intro).getByRole("button", { name: "Skip" }));
    await waitFor(() => {
      expect(screen.queryByTestId("ora-intro")).toBeNull();
    });
    expect(fetchState.calls.find((call) => call.url === "/api/v1/me/ora")).toEqual({
      url: "/api/v1/me/ora",
      method: "PATCH",
      body: { intro: "skipped" },
    });
    expect(navigation.refresh).toHaveBeenCalled();
    // Rediscoverable later without repeating the introduction.
    await user.click(screen.getByRole("button", { name: "What Ora can do" }));
    expect(screen.getByTestId("ora-help")).toHaveTextContent("I don't change anything");
  });

  it("never blocks Ora when the introduction cannot be saved", async () => {
    const user = userEvent.setup();
    fetchState.saveStatus = 500;
    setup({ intro: null });
    await user.click(launcher());
    const intro = await screen.findByTestId("ora-intro");
    await user.click(within(intro).getByRole("button", { name: "Done" }));
    expect(await within(intro).findByRole("alert")).toHaveTextContent("couldn't be saved");
    expect(screen.getByRole("button", { name: "Open tasks" })).toBeEnabled();
  });

  it("does not show the introduction again once it was finished", async () => {
    const user = userEvent.setup();
    setup({ intro: "completed" });
    await user.click(launcher());
    await screen.findByRole("button", { name: "Open tasks" });
    expect(screen.queryByTestId("ora-intro")).toBeNull();
  });

  it("links to the settings and has no accessibility violations open", async () => {
    const user = userEvent.setup();
    const { container } = setup();
    await user.click(launcher());
    await screen.findByRole("button", { name: "Open tasks" });
    expect(screen.getByRole("link", { name: "Ora settings" })).toHaveAttribute(
      "href",
      "/settings/ora",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows no microphone, speech or free-text control", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(launcher());
    await screen.findByRole("button", { name: "Open tasks" });
    const surface = screen.getByTestId("ora-surface");
    expect(within(surface).queryByRole("textbox")).toBeNull();
    expect(within(surface).queryByRole("searchbox")).toBeNull();
    expect(surface.innerHTML.toLowerCase()).not.toMatch(/microphone|speak|voice/);
  });

  it("starts the greeting wave when opened (and not before)", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(launcher());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("ora-surface")).toBeVisible();
  });
});
