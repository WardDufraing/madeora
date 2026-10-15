import { screen } from "@testing-library/react";

import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { RecoveryNotice } from "./recovery-notice";

interface Case {
  id: string;
  viewer: "claimant" | "owner" | "member";
  state: string;
  createdAt: string;
  objectionEndsAt: string | null;
  claimantMembershipId: string | null;
  objected: boolean;
}
const state = vi.hoisted(() => ({ cases: [] as Case[] }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const DAVE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { default: en } = await import("@/i18n/messages/en.json");
  return {
    getTranslations: (namespace: string) =>
      Promise.resolve(
        createTranslator({ locale: "en", messages: en, namespace: namespace as "Recovery" }),
      ),
  };
});
vi.mock("@/recovery/server", () => ({
  getRecoveryStatus: () => Promise.resolve({ status: "ok", cases: state.cases }),
}));
vi.mock("@/members/directory", () => ({
  getHomeDirectory: () =>
    Promise.resolve({
      status: "ok",
      members: [{ membershipId: DAVE, name: "Dave", role: "member", isSelf: false }],
    }),
}));
vi.mock("@/invitations/server", () => ({
  getDateTimeFormats: () =>
    Promise.resolve({ timeZone: "UTC", dateFormat: "dmy-slash", timeFormat: "24h", locale: "en" }),
}));

function openCase(viewer: Case["viewer"], overrides: Partial<Case> = {}): Case {
  return {
    id: "case-1",
    viewer,
    state: "in_review",
    createdAt: "2026-10-01T10:00:00Z",
    objectionEndsAt: null,
    claimantMembershipId: viewer === "owner" ? DAVE : null,
    objected: false,
    ...overrides,
  };
}

async function show(accepted = false) {
  const element = await RecoveryNotice({ homeId: HOME_ID, homeName: "Thuis", accepted });
  return renderWithQuery(<>{element}</>);
}

describe("RecoveryNotice", () => {
  it("shows nothing without a case", async () => {
    state.cases = [];
    const { container } = await show();
    expect(container).toBeEmptyDOMElement();
  });

  it("tells the Owner who asked, that it stopped, and offers I still have access", async () => {
    state.cases = [openCase("owner", { state: "owner_returned" })];
    const { container } = await show();
    expect(
      screen.getByRole("heading", { name: "Someone asked to take over ownership of Thuis" }),
    ).toBeVisible();
    expect(screen.getByText(/Dave asked Madeora on/)).toBeVisible();
    expect(screen.getByRole("button", { name: "I still have access" })).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows other members only that a review is open, never who asked", async () => {
    state.cases = [openCase("member")];
    await show();
    expect(screen.getByTestId("recovery-member-notice")).toHaveTextContent(
      "An ownership review is open for Thuis",
    );
    expect(screen.queryByText(/Dave/)).toBeNull();
    expect(screen.getByRole("link", { name: "Open ownership recovery" })).toHaveAttribute(
      "href",
      `/homes/${HOME_ID}/recovery`,
    );
  });

  it("drops the link once the member has objected, and hides a stopped case", async () => {
    state.cases = [openCase("member", { objected: true })];
    await show();
    expect(screen.getByText(/You objected/)).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("hides a case the Owner already stopped from other members", async () => {
    state.cases = [openCase("member", { state: "owner_returned" })];
    const { container } = await show();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the person who asked where their request stands", async () => {
    state.cases = [
      openCase("claimant", { state: "approved", objectionEndsAt: "2026-10-29T16:00:00Z" }),
    ];
    await show();
    expect(screen.getByTestId("recovery-claimant-notice")).toHaveTextContent(
      "Other members can object until 29/10/2026 16:00",
    );
  });

  it("confirms an accepted ownership once", async () => {
    state.cases = [openCase("claimant", { state: "completed" })];
    await show(true);
    expect(screen.getByText("You are now the Owner of Thuis.")).toBeVisible();
    expect(screen.queryByTestId("recovery-claimant-notice")).toBeNull();
  });
});
