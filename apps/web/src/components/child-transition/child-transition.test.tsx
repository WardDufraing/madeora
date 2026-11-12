import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { ChildTransitionSetting, type ChildTransitionView } from "./child-transition-setting";
import { ClaimConfirm } from "./claim-confirm";
import { ClaimForm } from "./claim-form";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;
const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const CHILD_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031";
const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const ENDPOINT = `/api/v1/homes/${HOME_ID}/children/${CHILD_ID}/transition`;

const closed: ChildTransitionView = {
  open: false,
  claimExpires: null,
  emailGiven: false,
  requiredAge: 16,
  canStart: true,
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

describe("ChildTransitionSetting", () => {
  it("checks the age and shows the claim link once", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <ChildTransitionSetting
        homeId={HOME_ID}
        membershipId={CHILD_ID}
        childName="Mia"
        state={closed}
      />,
    );
    expect(screen.getByText(/16 or older for their Homes/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Check age and start" }));
    expect(await screen.findByText("Enter a valid date.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockReturnValueOnce(
      answer(200, { outcome: "not_eligible", eligibleOn: "2029-03-04" }),
    );
    await user.type(screen.getByLabelText(/Mia's birth date/), "2013-03-04");
    await user.click(screen.getByRole("button", { name: "Check age and start" }));
    expect(
      await screen.findByText(
        "Mia can manage their own account from March 4, 2029. Nothing was started.",
      ),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(ENDPOINT);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ birthDate: "2013-03-04" });

    const claimUrl = `http://app.test/claim?token=${TOKEN}`;
    fetchMock.mockReturnValueOnce(
      answer(200, { outcome: "started", claimUrl, expiresAt: "2026-11-19T10:00:00Z" }),
    );
    await user.type(screen.getByLabelText(/Mia's birth date/), "2008-03-04");
    await user.click(screen.getByRole("button", { name: "Check age and start" }));
    expect(await screen.findByText("The move is started. Give Mia this link.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Link for the young person/)).toHaveValue(claimUrl);
    expect(screen.getByLabelText(/Mia's birth date/)).toHaveValue("");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("lets a guardian who may not start it still cancel an open move", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <ChildTransitionSetting
        homeId={HOME_ID}
        membershipId={CHILD_ID}
        childName="Mia"
        state={{
          ...closed,
          open: true,
          claimExpires: "19 Nov, 10:00",
          emailGiven: true,
          canStart: false,
        }}
      />,
    );
    expect(screen.getByText(/A move is open until 19 Nov, 10:00/)).toHaveTextContent(
      "Mia has given an email address",
    );
    expect(screen.queryByLabelText(/birth date/)).not.toBeInTheDocument();
    expect(screen.getByText(/Only someone who is Mia's primary guardian/)).toBeInTheDocument();
    fetchMock.mockReturnValueOnce(answer(200, { outcome: "cancelled" }));
    await user.click(screen.getByRole("button", { name: "Cancel the move" }));
    expect(await screen.findByText("The move is cancelled. Nothing changed.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${ENDPOINT}/cancel`);
  });
});

describe("ClaimForm", () => {
  it("sends a verification link to the young person's own address", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(<ClaimForm token={TOKEN} />);
    expect(await axeViolations(container)).toEqual([]);
    fetchMock.mockReturnValueOnce(answer(409, { error: "email-taken" }));
    await user.type(screen.getByLabelText(/Your email address/), "taken@example.org");
    await user.click(screen.getByRole("button", { name: "Send confirmation link" }));
    expect(
      await screen.findByText("This address is already used by another account."),
    ).toBeInTheDocument();

    fetchMock.mockReturnValueOnce(answer(200, {}));
    await user.clear(screen.getByLabelText(/Your email address/));
    await user.type(screen.getByLabelText(/Your email address/), "mia@example.org");
    await user.click(screen.getByRole("button", { name: "Send confirmation link" }));
    expect(
      await screen.findByText(
        "We sent a link to mia@example.org. Open it within an hour to confirm.",
      ),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/claim");
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({
      token: TOKEN,
      email: "mia@example.org",
    });
  });
});

describe("ClaimConfirm", () => {
  it("needs an express confirmation, then points to choosing a password", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(<ClaimConfirm token={TOKEN} email="mia@example.org" />);
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Tick this to confirm.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockReturnValueOnce(answer(200, {}));
    await user.click(screen.getByRole("checkbox", { name: /I want to manage my account myself/ }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Done. Your account is now yours.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/claim/complete");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ token: TOKEN });
    expect(screen.getByRole("link", { name: "Choose my password" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    await waitFor(() => {
      expect(screen.getByText(/enter mia@example.org/)).toBeInTheDocument();
    });
  });
});
