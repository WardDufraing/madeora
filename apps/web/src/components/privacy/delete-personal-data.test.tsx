import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DELETION_CATEGORIES, type DeletionCategory } from "@/privacy/catalogue";
import { personalDeletionSchema } from "@/privacy/schema";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { DeletePersonalData, type CategoryCounts } from "./delete-personal-data";

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
const ANN = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const empty: CategoryCounts = { items: 0, inTrash: 0, shared: 0, files: 0, openCopies: 0 };
const counts = Object.fromEntries(DELETION_CATEGORIES.map((c) => [c, empty])) as Record<
  DeletionCategory,
  CategoryCounts
>;
counts.recipes = { items: 4, inTrash: 1, shared: 2, files: 3, openCopies: 1 };
counts.calendar = { items: 2, inTrash: 0, shared: 0, files: 0, openCopies: 0 };

const person = {
  email: "ann@example.com",
  userId: ANN,
  twoFactor: false,
  hasPassword: true,
  confirmed: null,
  counts,
  openExports: 1,
} as const;

beforeEach(() => {
  vi.resetAllMocks();
  reauthenticate.mockResolvedValue(null);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("crypto", { randomUUID: () => "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d" });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("personalDeletionSchema", () => {
  it("takes known, distinct categories and the confirmation word only", () => {
    const base = {
      requestId: "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d",
      categories: ["recipes", "media"],
      confirmation: "VERWIJDER",
    };
    expect(personalDeletionSchema.safeParse(base).success).toBe(true);
    expect(personalDeletionSchema.safeParse({ ...base, categories: [] }).success).toBe(false);
    expect(personalDeletionSchema.safeParse({ ...base, categories: ["security"] }).success).toBe(
      false,
    );
    expect(personalDeletionSchema.safeParse({ ...base, confirmation: "delete" }).success).toBe(
      false,
    );
  });
});

describe("DeletePersonalData", () => {
  it("previews the impact, needs every acknowledgement and the word, then shows each result", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: "reauthentication-required" }, { status: 403 }))
      .mockResolvedValueOnce(
        Response.json({
          status: "partial",
          results: {
            calendar: { outcome: "deleted", count: 2 },
            recipes: { outcome: "failed" },
          },
        }),
      );
    const { container } = renderWithIntl(<DeletePersonalData {...person} />);
    expect(await axeViolations(container)).toEqual([]);
    expect(screen.getByText("4 items, 1 in the trash")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("data-deletion-category-recipes"));
    await userEvent.click(screen.getByTestId("data-deletion-category-calendar"));
    const impact = screen.getByTestId("data-deletion-impact");
    expect(impact).toHaveTextContent("2 items are shared with a Home");
    expect(impact).toHaveTextContent("3 files are deleted with them.");
    expect(impact).toHaveTextContent("1 copy request to a Home ends.");
    expect(impact).toHaveTextContent("Copies you made into a Home earlier are not deleted");
    expect(impact).toHaveTextContent("Nothing is deleted in your Google account.");
    expect(impact).toHaveTextContent("Your export that is being prepared or ready");
    expect(await axeViolations(container)).toEqual([]);

    const remove = screen.getByRole("button", { name: "Delete 2 categories" });
    await userEvent.click(remove);
    expect(await screen.findByText("Confirm each category you chose.")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("data-deletion-ack-recipes"));
    await userEvent.click(screen.getByTestId("data-deletion-ack-calendar"));
    await userEvent.click(remove);
    expect(await screen.findByText("Type DELETE to confirm.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await userEvent.click(remove);
    const confirm = await screen.findByRole("form", {
      name: "Confirm it's you to delete this data.",
    });
    await userEvent.type(within(confirm).getByLabelText(/password/i), "correct horse");
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete 2 categories" }));

    expect(await screen.findByTestId("data-deletion-result")).toBeInTheDocument();
    expect(screen.getByTestId("data-deletion-result-calendar")).toHaveTextContent(
      "2 items deleted",
    );
    expect(screen.getByTestId("data-deletion-result-recipes")).toHaveTextContent(
      "couldn't be deleted",
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/me/personal-data/delete",
      expect.objectContaining({
        body: JSON.stringify({
          requestId: "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d",
          categories: ["calendar", "recipes"],
          confirmation: "DELETE",
        }),
      }),
    );
    expect(router.refresh).toHaveBeenCalled();

    // Only the failed category is chosen again, with fresh acknowledgements.
    await userEvent.click(screen.getByRole("button", { name: "Try the failed categories again" }));
    expect(screen.getByTestId("data-deletion-category-recipes")).toBeChecked();
    expect(screen.getByTestId("data-deletion-category-calendar")).not.toBeChecked();
    expect(screen.getByTestId("data-deletion-ack-recipes")).not.toBeChecked();
  });

  it("works in Dutch with VERWIJDER", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        status: "completed",
        results: { calendar: { outcome: "deleted", count: 2 } },
      }),
    );
    const { container } = renderWithIntl(<DeletePersonalData {...person} />, "nl");
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.click(screen.getByTestId("data-deletion-category-calendar"));
    await userEvent.click(screen.getByTestId("data-deletion-ack-calendar"));
    await userEvent.type(screen.getByLabelText("Typ VERWIJDER om te bevestigen"), "VERWIJDER");
    await userEvent.click(screen.getByRole("button", { name: "1 categorie verwijderen" }));
    expect(await screen.findByText("Je gegevens zijn verwijderd.")).toBeInTheDocument();
  });

  it("says when nothing could be deleted", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "failed" }, { status: 500 }));
    renderWithIntl(<DeletePersonalData {...person} />);
    await userEvent.click(screen.getByTestId("data-deletion-category-calendar"));
    await userEvent.click(screen.getByTestId("data-deletion-ack-calendar"));
    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await userEvent.click(screen.getByRole("button", { name: "Delete 1 category" }));
    expect(await screen.findByText(/Nothing was changed/)).toBeInTheDocument();
    await waitFor(() => {
      expect(router.refresh).not.toHaveBeenCalled();
    });
  });
});
