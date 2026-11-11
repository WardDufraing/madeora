import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { CancelPendingCopies } from "./cancel-pending-copies";
import { CopyToHome } from "./copy-to-home";
import { HomeCopyRequests } from "./home-copy-requests";
import { MyHomeCopies } from "./my-home-copies";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
const ITEM = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const OAK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f02";
const ELM = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f03";
const PINE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f04";
const REQUEST = "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d";

const homes = [
  { homeId: OAK, name: "Oak", mode: "direct", shared: true, open: false },
  { homeId: ELM, name: "Elm", mode: "approval", shared: false, open: false },
  { homeId: PINE, name: "Pine", mode: "direct", shared: false, open: true },
] as const;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { assign, origin: "http://localhost:3000" });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CopyToHome", () => {
  it("explains a copy, needs a Home and the acknowledgement, then shows each Home's result", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        homes: [
          { homeId: OAK, outcome: "completed", code: null },
          { homeId: ELM, outcome: "pending", code: null },
        ],
      }),
    );
    const { container } = renderWithIntl(
      <CopyToHome itemType="recipe" itemId={ITEM} files={1} homes={homes} backHref="/recipes/x" />,
    );
    expect(await axeViolations(container)).toEqual([]);
    expect(screen.getByText(/never update each other/)).toBeInTheDocument();
    expect(screen.getByText(/cover photo is copied/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Pine/ })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Copy to a Home" }));
    expect(await screen.findByText("Choose at least one Home.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /Oak/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Elm/ }));
    await userEvent.click(screen.getByRole("button", { name: "Copy to 2 Homes" }));
    expect(
      await screen.findByText("Confirm that you understand what a copy is."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("checkbox", { name: /doesn't stay in sync/ }));
    await userEvent.click(screen.getByRole("button", { name: "Copy to 2 Homes" }));
    expect(await screen.findByTestId("copy-result-completed")).toHaveTextContent("Oak: copied");
    expect(screen.getByTestId("copy-result-pending")).toHaveTextContent(
      "Elm: waiting for approval",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/me/home-copies",
      expect.objectContaining({
        body: JSON.stringify({ itemType: "recipe", itemId: ITEM, homeIds: [OAK, ELM] }),
      }),
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("names why a Home could not get its copy, in Dutch too", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ homes: [{ homeId: OAK, outcome: "failed", code: "storage_full" }] }),
    );
    const { container } = renderWithIntl(
      <CopyToHome
        itemType="photo_album"
        itemId={ITEM}
        files={3}
        homes={homes}
        backHref="/photos"
      />,
      "nl",
    );
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.click(screen.getByRole("checkbox", { name: /Oak/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /niet gelijk blijft/ }));
    await userEvent.click(screen.getByRole("button", { name: "Kopiëren naar 1 Home" }));
    expect(await screen.findByTestId("copy-result-failed")).toHaveTextContent(
      "de opslag van de Home is vol",
    );
  });

  it("says when the item can no longer be copied", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "not-found" }, { status: 404 }));
    renderWithIntl(
      <CopyToHome itemType="calendar_event" itemId={ITEM} files={0} homes={homes} backHref="/c" />,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: /Oak/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /doesn't stay in sync/ }));
    await userEvent.click(screen.getByRole("button", { name: "Copy to 1 Home" }));
    expect(await screen.findByText("This item can no longer be copied.")).toBeInTheDocument();
  });
});

describe("MyHomeCopies", () => {
  const rows = [
    {
      id: REQUEST,
      homeName: "Elm",
      itemType: "recipe",
      label: "Soup",
      status: "pending",
      code: null,
      selfApproved: false,
      requested: "1 Nov",
      expires: "1 Dec",
    },
    {
      id: ITEM,
      homeName: "Oak",
      itemType: "photo_album",
      label: null,
      status: "failed",
      code: "storage_full",
      selfApproved: false,
      requested: "2 Nov",
      expires: "2 Dec",
    },
  ] as const;

  it("lists each request with its state, and cancels a pending one", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ cancelled: true }));
    const { container } = renderWithIntl(<MyHomeCopies rows={rows} />);
    expect(await axeViolations(container)).toEqual([]);
    expect(screen.getByTestId("my-copy-pending")).toHaveTextContent("ends 1 Dec");
    expect(screen.getByTestId("my-copy-failed")).toHaveTextContent("the Home's storage is full");
    expect(screen.getByText("An album that no longer exists")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/me/home-copies/${REQUEST}/cancel`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("says when there is nothing", () => {
    renderWithIntl(<MyHomeCopies rows={[]} />, "nl");
    expect(
      screen.getByText("Je hebt nog niets naar een Home willen kopiëren."),
    ).toBeInTheDocument();
  });
});

describe("HomeCopyRequests", () => {
  const rows = [
    {
      id: REQUEST,
      itemType: "photo_album",
      label: "Summer",
      files: 12,
      requester: "Ann",
      isMine: false,
      requested: "1 Nov",
      expires: "1 Dec",
    },
  ] as const;

  it("shows the consequences before approving", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ outcome: "copying" }));
    const { container } = renderWithIntl(<HomeCopyRequests homeName="Oak" rows={rows} />);
    expect(await axeViolations(container)).toEqual([]);
    expect(screen.getByText(/Asked by Ann on 1 Nov/)).toHaveTextContent("12 photos");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText(/Oak gets its own copy/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Approve and copy" }));
    expect(await screen.findByText(/appears in the Home when ready/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/home-copies/${REQUEST}/decision`,
      expect.objectContaining({ body: JSON.stringify({ approve: true }) }),
    );
  });

  it("marks an approver's own request, and says when a request is gone", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "not-found" }, { status: 404 }));
    renderWithIntl(<HomeCopyRequests homeName="Oak" rows={[{ ...rows[0], isMine: true }]} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText(/asked and approved by you/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("This request can no longer be decided.")).toBeInTheDocument();
  });

  it("has an empty state in Dutch", async () => {
    const { container } = renderWithIntl(<HomeCopyRequests homeName="Oak" rows={[]} />, "nl");
    expect(await axeViolations(container)).toEqual([]);
    expect(screen.getByText("Er wachten geen kopieerverzoeken op jou.")).toBeInTheDocument();
  });
});

describe("CancelPendingCopies", () => {
  const rows = [
    {
      id: REQUEST,
      homeName: "Elm",
      itemType: "recipe",
      label: "Soup",
      status: "pending",
      expires: "1 Dec",
    },
    {
      id: ITEM,
      homeName: "Oak",
      itemType: "photo_album",
      label: "Summer",
      status: "copying",
      expires: "2 Dec",
    },
  ] as const;

  it("needs the acknowledgement before cancelling every pending request", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ cancelled: 1 }));
    const { container } = renderWithIntl(<CancelPendingCopies rows={rows} />);
    expect(await axeViolations(container)).toEqual([]);
    expect(screen.getByText(/Copies being made finish first/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel 1 request" }));
    expect(await screen.findByText("Confirm that you understand first.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox", { name: /won't be copied/ }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel 1 request" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/me/home-copies/cancel-pending",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("only waits while copies are running", () => {
    renderWithIntl(<CancelPendingCopies rows={[rows[1]]} />, "nl");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/worden eerst afgerond/)).toBeInTheDocument();
  });
});
