import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { accountDeletionSchema, closeHomeSchema } from "@/activity/schema";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { CloseHome } from "./close-home";
import { DeleteAccount } from "./delete-account";
import { RestoreHome } from "./restore-home";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/auth/captcha", () => ({
  useCaptcha: () => ({ ready: true, options: undefined, check: null, reset: vi.fn() }),
}));
const reauthenticate = vi.fn();
vi.mock("@/auth/reauthenticate", () => ({
  reauthenticate: (...args: unknown[]) => reauthenticate(...args) as unknown,
}));

const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
const ANN = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f03";

const person = {
  email: "ann@example.com",
  userId: ANN,
  twoFactor: false,
  hasPassword: true,
  confirmed: null,
} as const;

beforeEach(() => {
  vi.resetAllMocks();
  reauthenticate.mockResolvedValue(null);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { assign, origin: "http://localhost:3000" });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deletion schemas", () => {
  it("accepts only the confirmation word, in either language", () => {
    expect(accountDeletionSchema.safeParse({ confirmation: "DELETE" }).success).toBe(true);
    expect(accountDeletionSchema.safeParse({ confirmation: "VERWIJDER" }).success).toBe(true);
    expect(accountDeletionSchema.safeParse({ confirmation: "delete" }).success).toBe(false);
    expect(accountDeletionSchema.safeParse({}).success).toBe(false);
    expect(accountDeletionSchema.safeParse({ confirmation: "DELETE", userId: ANN }).success).toBe(
      false,
    );
  });

  it("needs a Home name within its length", () => {
    expect(closeHomeSchema.safeParse({ name: "Oak" }).success).toBe(true);
    expect(closeHomeSchema.safeParse({ name: "" }).success).toBe(false);
    expect(closeHomeSchema.safeParse({ name: "x".repeat(201) }).success).toBe(false);
  });
});

describe("DeleteAccount", () => {
  it("sends an Owner to transfer ownership or close the Home first", () => {
    renderWithIntl(<DeleteAccount {...person} blockers={[{ homeId: HOME, homeName: "Oak" }]} />);
    expect(screen.getByText("Oak")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Transfer ownership or close the Home" }),
    ).toHaveAttribute("href", `/homes/${HOME}/leave`);
    expect(screen.queryByRole("button", { name: "Delete my account" })).not.toBeInTheDocument();
  });

  it("asks for the word, then to confirm it's you, then signs out to the notice", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: "reauthentication-required" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ purgeAfter: "2026-12-10T09:00:00+00:00" }));
    const { container } = renderWithIntl(<DeleteAccount {...person} blockers={[]} />);
    expect(await axeViolations(container)).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    expect(await screen.findByText(/Type DELETE to confirm that/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), " DELETE ");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    const confirm = await screen.findByRole("form", {
      name: "Confirm it's you to delete your account.",
    });
    await userEvent.type(within(confirm).getByLabelText(/password/i), "correct horse");
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete my account" }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalled();
    });
    expect(String(assign.mock.calls[0]?.[0])).toContain("/sign-in?status=deletion_requested");
    expect(reauthenticate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/me/delete-account",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmation: "DELETE" }) }),
    );
  });

  it("says when a Home still needs another Owner", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "sole-owner" }, { status: 409 }));
    renderWithIntl(<DeleteAccount {...person} blockers={[]} />);
    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    expect(await screen.findByText(/You're the Owner of a Home/)).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("says when copy requests to Homes must be cancelled or finish first", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: "pending-copies" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: "copies-running" }, { status: 409 }));
    renderWithIntl(<DeleteAccount {...person} blockers={[]} />);
    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    expect(await screen.findByText(/waiting for approval. Cancel them first/)).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    expect(await screen.findByText(/still being made/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("accepts the Dutch word in Dutch", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ purgeAfter: null }));
    const { container } = renderWithIntl(<DeleteAccount {...person} blockers={[]} />, "nl");
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.type(screen.getByRole("textbox"), "VERWIJDER");
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(assign).toHaveBeenCalled();
    });
  });
});

describe("CloseHome", () => {
  it("needs the Home's exact name before anything is sent", async () => {
    const { container } = renderWithIntl(<CloseHome {...person} homeId={HOME} homeName="Oak" />);
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.type(screen.getByLabelText("Type the Home's name to confirm"), "oak");
    await userEvent.click(screen.getByRole("button", { name: "Close the Home" }));
    expect(
      await screen.findByText("Type the Home's name exactly as it's written."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes the Home and opens the closed Homes", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ purgeAfter: "2026-12-10T09:00:00+00:00" }));
    renderWithIntl(<CloseHome {...person} homeId={HOME} homeName="Oak" />);
    await userEvent.type(screen.getByLabelText("Type the Home's name to confirm"), "Oak");
    await userEvent.click(screen.getByRole("button", { name: "Close the Home" }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalled();
    });
    expect(String(assign.mock.calls[0]?.[0])).toContain("/settings/closed-homes?status=closed");
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/v1/homes/${HOME}/close`,
      expect.objectContaining({ body: JSON.stringify({ name: "Oak" }) }),
    );
  });
});

describe("RestoreHome", () => {
  it("restores the Home and opens it", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}));
    renderWithIntl(<RestoreHome {...person} homeId={HOME} />);
    await userEvent.click(screen.getByRole("button", { name: "Restore the Home" }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalled();
    });
    expect(String(assign.mock.calls[0]?.[0])).toContain(`/homes/${HOME}`);
  });

  it("says when the 30 days have passed", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "expired" }, { status: 410 }));
    renderWithIntl(<RestoreHome {...person} homeId={HOME} />);
    await userEvent.click(screen.getByRole("button", { name: "Restore the Home" }));
    expect(await screen.findByText(/can no longer be restored/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
