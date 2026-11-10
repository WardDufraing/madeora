import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { exportRequestSchema } from "@/privacy/schema";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { DataExport, type ExportRow } from "./data-export";
import { HomeExportAccessForm } from "./home-export-access-form";
import { PrivacyReview } from "./privacy-review";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const reauthenticate = vi.fn();
vi.mock("@/auth/reauthenticate", () => ({
  reauthenticate: (...args: unknown[]) => reauthenticate(...args) as unknown,
}));

const fetchMock = vi.fn<typeof fetch>();
const HOME_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const HOME_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f02";
const EXPORT = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f03";

beforeEach(() => {
  vi.resetAllMocks();
  reauthenticate.mockResolvedValue(null);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function sentBody(): unknown {
  const init = fetchMock.mock.lastCall?.[1];
  return JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;
}

const props = {
  email: "ann@example.com",
  userId: "user-1",
  twoFactor: false,
  hasPassword: true,
  confirmed: null,
  storageOn: true,
  homes: [
    { id: HOME_A, name: "Oak" },
    { id: HOME_B, name: "Elm" },
  ],
} as const;

function row(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    id: EXPORT,
    kind: "personal",
    status: "ready",
    allData: true,
    categories: [],
    homeNames: ["Oak"],
    formerHomes: 0,
    partial: false,
    requested: "10/11/2026 12:00",
    expires: "17/11/2026 12:05",
    size: "1.2 MB",
    downloaded: null,
    counts: { tasks: 3 },
    omittedAttachments: 0,
    failureCode: null,
    ...overrides,
  };
}

describe("exportRequestSchema", () => {
  it("needs a category unless everything is chosen, and a Home for contributions", () => {
    expect(
      exportRequestSchema.safeParse({ allData: true, categories: [], homeIds: [] }).success,
    ).toBe(true);
    expect(
      exportRequestSchema.safeParse({ allData: false, categories: [], homeIds: [] }).success,
    ).toBe(false);
    expect(
      exportRequestSchema.safeParse({
        allData: false,
        categories: ["home_contributions"],
        homeIds: [],
      }).success,
    ).toBe(false);
    expect(
      exportRequestSchema.safeParse({ allData: false, categories: ["passwords"], homeIds: [] })
        .success,
    ).toBe(false);
  });
});

describe("DataExport", () => {
  it("asks to confirm it's you, then requests All eligible data for the chosen Homes", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: "reauthentication-required" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ id: EXPORT }, { status: 201 }));
    const { container } = renderWithIntl(<DataExport {...props} exports={[]} />);
    expect(await axeViolations(container)).toEqual([]);
    expect(
      screen.getByText(
        "Records owned by a Home (its tasks, chores, recipes, pets, photos and so on)",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Elm" }));
    await userEvent.click(screen.getByRole("button", { name: "Prepare export" }));
    const confirm = await screen.findByRole("form", {
      name: "Confirm it's you to prepare the export.",
    });
    await userEvent.type(within(confirm).getByLabelText(/password/i), "correct horse");
    await userEvent.click(within(confirm).getByRole("button", { name: "Prepare export" }));
    expect(await screen.findByText(/Your export is being prepared/)).toBeInTheDocument();
    expect(reauthenticate).toHaveBeenCalledTimes(1);
    expect(sentBody()).toEqual({ allData: true, categories: [], homeIds: [HOME_A] });
  });

  it("explains an empty selection and a contribution without a Home", async () => {
    renderWithIntl(<DataExport {...props} homes={[]} exports={[]} />, "nl");
    await userEvent.click(screen.getByRole("radio", { name: "Categorieën kiezen" }));
    await userEvent.click(screen.getByRole("button", { name: "Export voorbereiden" }));
    expect(await screen.findByText("Kies minstens één categorie.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Mijn bijdragen in Homes" }));
    await userEvent.click(screen.getByRole("button", { name: "Export voorbereiden" }));
    expect(
      await screen.findByText(
        "Kies minstens één Home voor je bijdragen, of vink die categorie uit.",
      ),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the choice made before confirming with Google", () => {
    window.sessionStorage.setItem(
      "madeora.privacy.export-selection",
      JSON.stringify({ allData: false, categories: ["tasks"], homeIds: [HOME_B, EXPORT] }),
    );
    renderWithIntl(
      <DataExport {...props} hasPassword={false} confirmed="data_export" exports={[]} />,
    );
    expect(screen.getByRole("radio", { name: "Choose categories" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Personal tasks" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Oak" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Elm" })).toBeChecked();
    expect(window.sessionStorage.getItem("madeora.privacy.export-selection")).toBeNull();
  });

  it("downloads through a short-lived link and explains an export invalidated by an access change", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, origin: "http://localhost" });
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ url: "https://storage.test/archive" }, { status: 200 }),
      )
      .mockResolvedValueOnce(Response.json({ error: "invalidated" }, { status: 410 }));
    const { container } = renderWithIntl(<DataExport {...props} exports={[row()]} />);
    expect(await axeViolations(container)).toEqual([]);
    expect(screen.getByText("Ready until 17/11/2026 12:05")).toBeInTheDocument();
    const download = screen.getByRole("button", {
      name: "Download All eligible data requested 10/11/2026 12:00",
    });
    await userEvent.click(download);
    expect(assign).toHaveBeenCalledWith("https://storage.test/archive");
    await userEvent.click(download);
    expect(
      await screen.findByText(/Your access changed since this export was prepared/),
    ).toBeInTheDocument();
  });

  it("shows preparation, failure and partial states with what to do next", () => {
    renderWithIntl(
      <DataExport
        {...props}
        exports={[
          row({ id: "a", status: "preparing", expires: null, counts: null }),
          row({ id: "b", status: "failed", expires: null, counts: null }),
          row({ id: "c", status: "ready", partial: true, omittedAttachments: 2 }),
        ]}
      />,
    );
    expect(screen.getByText("Being prepared")).toBeInTheDocument();
    expect(screen.getByText(/Something went wrong while preparing it/)).toBeInTheDocument();
    expect(screen.getByText(/Not complete: 2 files were too large/)).toBeInTheDocument();
    // One export at a time: the request is disabled while one is being prepared.
    expect(screen.getByRole("button", { name: "Prepare export" })).toBeDisabled();
  });
});

describe("DataExport for a Home", () => {
  const home = { id: HOME_A, name: "Oak" };

  it("offers the Home's own categories and requests them from the Home's endpoint", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: EXPORT }, { status: 201 }));
    const { container } = renderWithIntl(
      <DataExport {...props} home={home} homes={[]} confirmed="data_export" exports={[]} />,
    );
    expect(await axeViolations(container)).toEqual([]);
    // No personal categories and no Home picker: only this Home's records.
    expect(screen.queryByRole("checkbox", { name: "Elm" })).toBeNull();
    expect(
      screen.getByText("Only Oak's own records, as you may see them now."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Personal items members shared into the Home (they stay their owners')"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Choose categories" }));
    expect(screen.queryByRole("checkbox", { name: "My contributions in Homes" })).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "Pets" }));
    await userEvent.click(screen.getByRole("button", { name: "Prepare export" }));
    expect(await screen.findByText(/Your export is being prepared/)).toBeInTheDocument();
    expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/homes/${HOME_A}/exports`);
    expect(sentBody()).toEqual({ allData: false, categories: ["pets"] });
  });

  it("says when the person may not export the Home", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "not-permitted" }, { status: 403 }));
    renderWithIntl(
      <DataExport {...props} home={home} homes={[]} confirmed="data_export" exports={[]} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Prepare export" }));
    expect(
      await screen.findByText("You may not export this Home's data. The Owner can allow it."),
    ).toBeInTheDocument();
  });
});

describe("HomeExportAccessForm", () => {
  const MEMBERSHIP = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f04";

  it("lets the Owner allow a member to export, saving only a change", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ outcome: "ok" }, { status: 200 }));
    const { container } = renderWithIntl(
      <HomeExportAccessForm
        homeId={HOME_A}
        membershipId={MEMBERSHIP}
        memberName="Ann"
        granted={false}
      />,
    );
    expect(await axeViolations(container)).toEqual([]);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Ann may export this Home's data" }),
    );
    await userEvent.click(save);
    expect(await screen.findByText("Saved for Ann.")).toBeInTheDocument();
    expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/homes/${HOME_A}/export-access`);
    expect(fetchMock.mock.lastCall?.[1]?.method).toBe("PUT");
    expect(sentBody()).toEqual({ membershipId: MEMBERSHIP, granted: true });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("says when only the Owner may change it", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "not-permitted" }, { status: 403 }));
    renderWithIntl(
      <HomeExportAccessForm homeId={HOME_A} membershipId={MEMBERSHIP} memberName="Ann" granted />,
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Ann may export this Home's data" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Only the Owner can change this.")).toBeInTheDocument();
  });
});

describe("PrivacyReview", () => {
  const panels = {
    profile: <p>Shown as Ann</p>,
    homes: <p>Oak</p>,
    connections: <p>Not connected</p>,
    security: <p>Password set</p>,
    devices: <p>1 device</p>,
    data_rights: <p>No exports</p>,
  };
  const changeLinks = {
    profile: "/settings",
    homes: null,
    connections: "/settings/google-calendar",
    security: "/settings/security",
    devices: "/settings/security#sessions",
    data_rights: "/settings/privacy/export",
  };

  it("walks through the steps, saving only the position, and finishes without changing settings", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({}, { status: 200 })));
    const { container } = renderWithIntl(
      <PrivacyReview state={null} unavailable={false} panels={panels} changeLinks={changeLinks} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Start the review" }));
    expect(await screen.findByRole("heading", { name: "Your profile" })).toHaveFocus();
    expect(sentBody()).toEqual({ action: "start" });
    expect(await axeViolations(container)).toEqual([]);
    expect(screen.getByRole("link", { name: "Change setting" })).toHaveAttribute(
      "href",
      "/settings",
    );
    await userEvent.click(screen.getByRole("button", { name: "Keep as is" }));
    expect(await screen.findByRole("heading", { name: "Your Homes" })).toBeInTheDocument();
    expect(sentBody()).toEqual({ action: "step", step: "homes" });
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Your profile" })).toBeInTheDocument();
    for (let i = 0; i < 5; i += 1) {
      const name = i % 2 === 0 ? "Keep as is" : "Skip";
      await userEvent.click(await screen.findByRole("button", { name }));
    }
    expect(await screen.findByRole("heading", { name: "Your data" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(sentBody()).toEqual({ action: "finish" });
    expect(await screen.findByText(/Review completed/)).toBeInTheDocument();
  });

  it("resumes where the person left off and says when progress was not saved", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "failed" }, { status: 500 }));
    renderWithIntl(
      <PrivacyReview
        state={{ step: "devices", completed: false }}
        unavailable={false}
        panels={panels}
        changeLinks={changeLinks}
      />,
      "nl",
    );
    expect(screen.getByRole("heading", { name: "Apparaten" })).toBeInTheDocument();
    expect(screen.getAllByText("Stap 5 van 6").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Zo laten" }));
    expect(
      await screen.findByText(
        "Je voortgang kon niet worden opgeslagen. Er is niets gewijzigd; probeer het opnieuw.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Apparaten" })).toBeInTheDocument();
  });
});
