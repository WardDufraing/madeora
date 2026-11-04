// S31 care part: pet care in the interface. The database decides every right
// (tests/db/rls/pet-care.test.sql); these tests check what people read in en and nl, what is sent,
// that a concealed activity shows only its category, and that the views pass automated checks.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ACTIVITY,
  HOME,
  MEMBERSHIP,
  OCCURRENCE,
  OTHER_MEMBERSHIP,
  PET,
  careActivity,
  careActivityDetail,
  careOccurrence,
  homeCare,
  petCare,
  petDetail,
  petList,
} from "@/pets/testing";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { CareActivityView } from "./care-activity-view";
import type { CareMember } from "./care-parts";
import { PetCareSection } from "./pet-care";
import { PetCareWidgetBody } from "./pet-care-widget-body";
import { PetCareWidgetSettings } from "./pet-care-widget-settings";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/pets" }));

const fetchMock = vi.fn<typeof fetch>();
const urlOf = (input: RequestInfo | URL | undefined): string =>
  input === undefined
    ? ""
    : typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
const reply = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
function sent(part: string, method: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => urlOf(input).includes(part) && (init?.method ?? "GET") === method)
    .map(([, init]) =>
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    );
}

const members: CareMember[] = [
  { id: MEMBERSHIP, name: "Ward", isSelf: true },
  { id: OTHER_MEMBERSHIP, name: "Sam", isSelf: false },
];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => reply(200, { outcome: "completed", revision: 2 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
  router.push.mockClear();
});

describe("a pet's Care section", () => {
  it("shows each activity's schedule, next time, status and who, and records Done", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <PetCareSection pet={petDetail()} care={petCare()} members={members} />,
    );
    const item = screen.getByTestId("care-item");
    expect(item).toHaveTextContent("Breakfast");
    expect(item).toHaveTextContent("Feeding · Every day from");
    expect(item).toHaveTextContent("at 07:30");
    expect(item).toHaveTextContent("Next: Today at 07:30");
    expect(within(item).getByTestId("care-status")).toHaveTextContent("Due");
    expect(item).toHaveTextContent("You");
    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Mark Breakfast for Miso done" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(sent(`/pet-care-occurrences/${OCCURRENCE}`, "POST")[0]).toEqual({
      action: "complete",
      revision: 1,
    });
  });

  it("shows overdue care and a paused activity apart", () => {
    renderWithQuery(
      <PetCareSection
        pet={petDetail()}
        care={petCare({
          activities: [
            careActivity({ overdue: 2, next: careOccurrence({ status: "overdue" }) }),
            careActivity({ id: OCCURRENCE, title: "Brushing", state: "paused", next: null }),
          ],
        })}
        members={members}
      />,
    );
    const [first, second] = screen.getAllByTestId("care-item");
    expect(first).toHaveTextContent("2 overdue");
    expect(second).toHaveTextContent("Paused");
    expect(within(second ?? document.body).queryByTestId("care-complete")).not.toBeInTheDocument();
  });

  it("names a concealed activity by its category only, in Dutch", () => {
    renderWithQuery(
      <PetCareSection
        pet={petDetail()}
        care={petCare({
          canManage: false,
          activities: [
            careActivity({
              title: null,
              instructions: null,
              category: "medication",
              medical: true,
              concealed: true,
              canEdit: false,
              canManage: false,
            }),
          ],
        })}
        members={members}
      />,
      "nl",
    );
    expect(screen.getByTestId("care-link")).toHaveTextContent("Medicatie");
    expect(screen.queryByText("Breakfast")).not.toBeInTheDocument();
    expect(screen.queryByTestId("care-new")).not.toBeInTheDocument();
  });

  it("adds care with a schedule and opens it, refusing a weekly schedule without days", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(201, { outcome: "created", id: ACTIVITY }));
    renderWithQuery(
      <PetCareSection
        pet={petDetail()}
        care={petCare({ activities: [], canManageMedical: false })}
        members={members}
      />,
    );
    await user.click(screen.getByTestId("care-new"));
    const dialog = screen.getByRole("dialog");
    // Medication is medical information: not offered without medical manage.
    expect(
      within(within(dialog).getByTestId("care-category")).queryByRole("option", {
        name: "Medication",
      }),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByTestId("care-save"));
    expect(await within(dialog).findByText("Enter a value.")).toBeInTheDocument();

    await user.type(within(dialog).getByRole("textbox", { name: /Title/u }), "Brushing");
    await user.selectOptions(within(dialog).getByTestId("care-category"), "grooming");
    await user.selectOptions(within(dialog).getByTestId("care-frequency"), "weekly");
    await user.click(within(dialog).getByTestId("care-save"));
    expect(await within(dialog).findByText("Choose at least one day.")).toBeInTheDocument();
    expect(sent("/care", "POST")).toEqual([]);

    await user.click(within(dialog).getByRole("checkbox", { name: "Sat" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Sam" }));
    await user.click(within(dialog).getByTestId("care-save"));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalled();
    });
    const body = sent(`/pets/${PET}/care`, "POST")[0];
    expect(body?.activity).toMatchObject({
      title: "Brushing",
      category: "grooming",
      medical: false,
    });
    expect(body?.schedule).toMatchObject({
      frequency: "weekly",
      weekdays: [6],
      members: [OTHER_MEMBERSHIP],
    });
    expect(router.push).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^/homes/${HOME}/pets/${PET}/care/`, "u")),
    );
  });
});

describe("a care activity's page", () => {
  const recent = careOccurrence({
    id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00c1",
    scheduledOn: "2026-11-03",
    dueOn: "2026-11-03",
    status: "completed",
    completedAt: "2026-11-03T06:40:00Z",
    completedBy: OTHER_MEMBERSHIP,
    recordedByMe: false,
    revision: 3,
    note: "Ate half",
  });

  it("shows open and recent care with who recorded it, and passes axe", async () => {
    const { container } = renderWithQuery(
      <CareActivityView
        activity={careActivityDetail({ recent: [recent] })}
        petName="Miso"
        members={members}
        canMarkMedical
      />,
    );
    expect(screen.getByTestId("care-heading")).toHaveTextContent("Breakfast");
    expect(screen.getByTestId("care-occurrence")).toHaveTextContent("Today at 07:30");
    // 06:40 UTC is 07:40 in Amsterdam: the Home's time zone, not the browser's.
    expect(screen.getByTestId("care-recorded")).toHaveTextContent("Done by Sam");
    expect(screen.getByTestId("care-recorded")).toHaveTextContent("07:40");
    expect(screen.getByTestId("care-done")).toHaveTextContent("Ate half");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("changes only one occurrence, or opens the schedule from it on", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(200, { outcome: "saved", revision: 2 }));
    renderWithQuery(
      <CareActivityView
        activity={careActivityDetail()}
        petName="Miso"
        members={members}
        canMarkMedical
      />,
    );
    await user.click(screen.getByTestId("care-change"));
    let dialog = screen.getByRole("dialog");
    const date = within(dialog).getByTestId("care-occurrence-date");
    await user.clear(date);
    await user.type(date, "2026-11-05");
    await user.click(within(dialog).getByTestId("care-change-save"));
    await waitFor(() => {
      expect(sent(`/pet-care-occurrences/${OCCURRENCE}`, "POST")).toHaveLength(1);
    });
    expect(sent(`/pet-care-occurrences/${OCCURRENCE}`, "POST")[0]).toEqual({
      action: "update",
      revision: 1,
      dueOn: "2026-11-05",
      time: "07:30",
      members: [MEMBERSHIP],
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await user.click(screen.getByTestId("care-change"));
    dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByTestId("care-scope-following"));
    await user.click(within(dialog).getByTestId("care-change-save"));
    const form = await screen.findByTestId("care-form");
    expect(within(form).getByTestId("care-from")).toHaveValue("2026-11-04");
  });

  it("skips for a responsible member, and offers a member no management", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(200, { outcome: "skipped", revision: 2 }));
    renderWithQuery(
      <CareActivityView
        activity={careActivityDetail({ canEdit: false, canManage: false, recent: [recent] })}
        petName="Miso"
        members={members}
        canMarkMedical={false}
      />,
    );
    expect(screen.queryByTestId("care-edit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("care-pause")).not.toBeInTheDocument();
    expect(screen.queryByTestId("care-delete")).not.toBeInTheDocument();
    expect(screen.queryByTestId("care-change")).not.toBeInTheDocument();
    // Someone else recorded it: no reopen or correct.
    expect(screen.queryByTestId("care-reopen")).not.toBeInTheDocument();
    expect(screen.queryByTestId("care-correct")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("care-skip"));
    await waitFor(() => {
      expect(sent(`/pet-care-occurrences/${OCCURRENCE}`, "POST")[0]).toEqual({
        action: "skip",
        revision: 1,
      });
    });
  });

  it("shows a concealed activity's category and the reason, without its texts", () => {
    renderWithQuery(
      <CareActivityView
        activity={careActivityDetail({
          title: null,
          instructions: null,
          category: "medication",
          medical: true,
          concealed: true,
          canEdit: false,
          canManage: false,
          recent: [{ ...recent, note: null, recordedByMe: true }],
        })}
        petName="Miso"
        members={members}
        canMarkMedical={false}
      />,
    );
    expect(screen.getByTestId("care-heading")).toHaveTextContent("Medication");
    expect(screen.getByTestId("care-concealed")).toBeInTheDocument();
    // The recorder may reopen, but not correct texts they cannot see.
    expect(screen.getByTestId("care-reopen")).toBeInTheDocument();
    expect(screen.queryByTestId("care-correct")).not.toBeInTheDocument();
  });
});

describe("the pet-care widget", () => {
  it("lists open care with links and Done, and says when there is none, in Dutch", async () => {
    const { container, unmount } = renderWithQuery(
      <PetCareWidgetBody
        homeId={HOME}
        care={homeCare({ hasMore: true })}
        members={members}
        days={1}
      />,
    );
    const row = screen.getByTestId("pet-care-widget-row");
    expect(within(row).getByRole("link", { name: "Breakfast" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/pets/${PET}/care/${ACTIVITY}`,
    );
    expect(within(row).getByRole("link", { name: "Miso" })).toBeInTheDocument();
    expect(row).toHaveTextContent("Today at 07:30");
    expect(screen.getByRole("link", { name: "More in Pets" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    unmount();

    renderWithQuery(
      <PetCareWidgetBody homeId={HOME} care={homeCare({ rows: [] })} members={members} days={3} />,
      "nl",
    );
    expect(screen.getByTestId("pet-care-widget-empty")).toHaveTextContent(
      "Geen verzorging in de komende 3 dagen.",
    );
  });

  it("offers the Home's pets in its settings, and keeps a pet that is gone as unavailable", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(200, { list: petList() }));
    const onChange = vi.fn();
    renderWithQuery(
      <PetCareWidgetSettings
        config={{ petId: OCCURRENCE, days: 1, who: "all", count: 5 }}
        homeId={HOME}
        onChange={onChange}
      />,
    );
    const select = await screen.findByTestId("pet-care-widget-pet");
    await waitFor(() => {
      expect(within(select).getByRole("option", { name: "Miso" })).toBeInTheDocument();
    });
    expect(
      within(select).getByRole("option", { name: "A pet that is no longer available" }),
    ).toBeInTheDocument();
    await user.selectOptions(select, PET);
    expect(onChange).toHaveBeenLastCalledWith({ petId: PET, days: 1, who: "all", count: 5 });
    expect(urlOf(fetchMock.mock.calls[0]?.[0])).toContain(`/api/v1/pets?homeId=${HOME}`);
  });
});
