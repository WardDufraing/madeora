import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Mock } from "vitest";

import { removeWidget, type DashboardLayout } from "@/dashboard/layout";
import { layoutPreview } from "@/dashboard/preview";
import { homeStarterLayout } from "@/dashboard/starter";
import type { HomeViews, WidgetEntry } from "@/dashboard/view-types";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { DashboardBoard } from "./dashboard-board";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const fetchMock: Mock<typeof fetch> = vi.fn();

const sharedWidgets = homeStarterLayout.widgets;
const added = sharedWidgets.find((widget) => widget.type === "home-members");
if (!added) throw new Error("the Home starter has a members widget");
/** The person's own view: the shared default without the widget it later gained. */
const ownView: DashboardLayout = removeWidget(homeStarterLayout, added.id);

function entriesFor(layout: DashboardLayout): WidgetEntry[] {
  return layout.widgets.map((widget) => ({
    id: widget.id,
    title: widget.type,
    sourceName: null,
    body: <p>{`Content of ${widget.type}`}</p>,
    type: widget.type,
    href: null,
    emptyState: "full",
    unavailable: false,
  }));
}

function views(overrides: Partial<HomeViews> = {}): HomeViews {
  return {
    homeId: HOME_ID,
    showing: "default",
    canHaveView: true,
    canEditShared: false,
    shared: {
      layout: homeStarterLayout,
      revision: 4,
      canUndo: false,
      preview: layoutPreview(homeStarterLayout),
    },
    suggestions: [],
    ...overrides,
  };
}

function renderBoard(
  homeViews: HomeViews,
  props: Partial<Parameters<typeof DashboardBoard>[0]> = {},
) {
  const showingMine = homeViews.showing === "mine";
  const layout = props.layout ?? (showingMine ? ownView : homeStarterLayout);
  return renderWithQuery(
    <DashboardBoard
      target={
        showingMine
          ? { kind: "home", homeId: HOME_ID, view: "mine" }
          : { kind: "home", homeId: HOME_ID }
      }
      layout={layout}
      revision={showingMine ? 2 : 4}
      canEdit={showingMine ? true : homeViews.canEditShared}
      canUndo={false}
      dropped={false}
      widgets={entriesFor(layout)}
      sourceHomes={[]}
      emptyState={<p>Nothing to show</p>}
      homeViews={homeViews}
      {...props}
    />,
  );
}

function urlOf(input: Parameters<typeof fetch>[0] | undefined): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Requests that change something, other than draft autosaves. */
function mutations() {
  return fetchMock.mock.calls.filter(
    ([url, init]) => init?.method !== undefined && !urlOf(url).includes("/dashboard/draft"),
  );
}
function draftReads() {
  return fetchMock.mock.calls.filter(
    ([url, init]) => init?.method === undefined && urlOf(url).includes("/dashboard/draft"),
  );
}

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url, init) => {
    const target = urlOf(url);
    if (target.includes("/dashboard/draft")) {
      return Promise.resolve(
        init?.method === undefined
          ? json(200, { draft: null })
          : init.method === "PUT"
            ? json(200, { updatedAt: "2026-11-25T10:00:00Z" })
            : json(200, { discarded: true }),
      );
    }
    if (init?.method === undefined) return Promise.resolve(json(200, { templates: [] }));
    if (target.endsWith("/home-view")) return Promise.resolve(json(200, { reset: true }));
    if (target.endsWith("/suggestions/dismiss"))
      return Promise.resolve(json(200, { dismissed: true }));
    return Promise.resolve(json(200, { revision: 1 }));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Adds the first widget the gallery offers, so Done has a change to save. */
async function addAnyWidget(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add widget" }));
  const catalogue = await screen.findByTestId("dashboard-catalogue");
  const [first] = within(catalogue).getAllByRole("button", { name: /^Add / });
  if (!first) throw new Error("the gallery offers a widget");
  await user.click(first);
}

describe("Home views: which dashboard is on screen (decision 33)", () => {
  it("names the shared default and offers no view or suggestions to someone who cannot keep one", async () => {
    renderBoard(views({ canHaveView: false, canEditShared: false }));
    expect(await screen.findByTestId("dashboard-view-label")).toHaveTextContent(
      "Shared Home default",
    );
    expect(screen.queryByRole("button", { name: "Customize" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-suggestions")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-return-shared")).not.toBeInTheDocument();
  });

  it("starts a member who may not edit the shared default on their own view, from revision 0", async () => {
    renderBoard(views());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    expect(await screen.findByTestId("dashboard-editing-label")).toHaveTextContent(
      "You are editing My Home view.",
    );
    expect(urlOf(draftReads()[0]?.[0])).toBe(`/api/v1/dashboard/draft?homeId=${HOME_ID}&view=mine`);
    await addAnyWidget(user);
    await user.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    const body = JSON.parse(mutations()[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body.target).toEqual({ kind: "home", homeId: HOME_ID, view: "mine" });
    expect(body.expectedRevision).toBe(0);
  });

  it("lets someone who may edit both choose the other dashboard with its own labelled button", async () => {
    renderBoard(views({ canEditShared: true }));
    const user = userEvent.setup();
    // Customize edits what is on screen, labelled; the personal view is a separate, explicit step.
    await user.click(screen.getByTestId("dashboard-customize-other"));
    expect(await screen.findByTestId("dashboard-editing-label")).toHaveTextContent(
      "You are editing My Home view.",
    );
    expect(urlOf(draftReads()[0]?.[0])).toBe(`/api/v1/dashboard/draft?homeId=${HOME_ID}&view=mine`);
  });

  it("edits the shared default, labelled, when the person may and it is on screen", async () => {
    renderBoard(views({ canEditShared: true }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    expect(await screen.findByTestId("dashboard-editing-label")).toHaveTextContent(
      "You are editing the Shared Home default.",
    );
    expect(urlOf(draftReads()[0]?.[0])).toBe(`/api/v1/dashboard/draft?homeId=${HOME_ID}`);
  });

  it("edits the person's view with Customize, and the shared default at its own revision with its own button", async () => {
    renderBoard(views({ showing: "mine", canEditShared: true }));
    const user = userEvent.setup();
    expect(screen.getByTestId("dashboard-customize-other")).toHaveTextContent(
      "Edit shared default",
    );
    await user.click(screen.getByTestId("dashboard-customize-other"));
    await screen.findByTestId("dashboard-editor");
    expect(screen.getByTestId("dashboard-editing-label")).toHaveTextContent(
      "You are editing the Shared Home default.",
    );
    await addAnyWidget(user);
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    const body = JSON.parse(mutations()[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body.target).toEqual({ kind: "home", homeId: HOME_ID });
    expect(body.expectedRevision).toBe(4);
  });

  it("has no accessibility violations", async () => {
    const { container } = renderBoard(views({ showing: "mine", suggestions: [added] }));
    await screen.findByTestId("dashboard-suggestions");
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("Home views: returning to the shared default", () => {
  it("previews the shared default, asks first, then ends only the person's view", async () => {
    renderBoard(views({ showing: "mine" }));
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("dashboard-return-shared"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("layout-preview")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("removed and cannot be brought back");
    expect(mutations()).toHaveLength(0);
    await user.click(within(dialog).getByTestId("dashboard-return-confirm"));
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    const [url, init] = mutations()[0] ?? [];
    expect(urlOf(url)).toBe("/api/v1/dashboard/home-view");
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(init?.body as string)).toEqual({ homeId: HOME_ID });
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
  });

  it("changes nothing when the person keeps their view", async () => {
    renderBoard(views({ showing: "mine" }));
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("dashboard-return-shared"));
    await user.click(await screen.findByRole("button", { name: "Keep my view" }));
    expect(mutations()).toHaveLength(0);
  });

  it("says plainly when it fails and keeps the dialog open", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(500, { error: "failed" })));
    renderBoard(views({ showing: "mine" }));
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("dashboard-return-shared"));
    await user.click(await screen.findByTestId("dashboard-return-confirm"));
    expect(await within(await screen.findByRole("dialog")).findByRole("alert")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("Home views: shared-default suggestions (decision 34)", () => {
  it("shows nothing when there is nothing new", async () => {
    renderBoard(views({ showing: "mine", suggestions: [] }));
    await screen.findByTestId("dashboard-view-label");
    expect(screen.queryByTestId("dashboard-suggestions")).not.toBeInTheDocument();
  });

  it("names the new widget quietly and changes nothing until the person chooses", async () => {
    renderBoard(views({ showing: "mine", suggestions: [added] }));
    const notice = await screen.findByTestId("dashboard-suggestions");
    expect(notice).toHaveTextContent("The shared default added a widget: Home members.");
    expect(mutations()).toHaveLength(0);
    expect(screen.queryByTestId("dashboard-editor")).not.toBeInTheDocument();
  });

  it("dismisses so it is not suggested again, then refreshes", async () => {
    renderBoard(views({ showing: "mine", suggestions: [added] }));
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("dashboard-suggestions-dismiss"));
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    const [url, init] = mutations()[0] ?? [];
    expect(urlOf(url)).toBe("/api/v1/dashboard/suggestions/dismiss");
    expect(JSON.parse(init?.body as string)).toEqual({ homeId: HOME_ID, widgetIds: [added.id] });
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
  });

  it("previews, adds the chosen widget to the person's view in edit mode and keeps its id", async () => {
    renderBoard(views({ showing: "mine", suggestions: [added] }));
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("dashboard-suggestions-review"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("layout-preview")).toBeInTheDocument();
    await user.click(within(dialog).getByTestId("dashboard-suggestions-add"));
    expect(await screen.findByTestId("dashboard-editing-label")).toHaveTextContent(
      "You are editing My Home view.",
    );
    expect(mutations()).toHaveLength(0);
    await user.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    const body = JSON.parse(mutations()[0]?.[1]?.body as string) as {
      target: unknown;
      expectedRevision: number;
      layout: DashboardLayout;
    };
    expect(body.target).toEqual({ kind: "home", homeId: HOME_ID, view: "mine" });
    expect(body.expectedRevision).toBe(2);
    expect(body.layout.widgets.map((widget) => widget.id)).toContain(added.id);
  });

  it("adds nothing when the person unticks every widget", async () => {
    renderBoard(views({ showing: "mine", suggestions: [added] }));
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("dashboard-suggestions-review"));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox"));
    expect(within(dialog).getByTestId("dashboard-suggestions-add")).toBeDisabled();
    expect(within(dialog).getByTestId("dashboard-suggestions-dismiss-selected")).toBeDisabled();
  });
});
