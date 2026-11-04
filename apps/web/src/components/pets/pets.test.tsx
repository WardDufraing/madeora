// S31: pets in the interface. The database decides every right (tests/db/rls/pets.test.sql); these
// tests check what people read and type in en and nl, what is sent, that nothing medical shows
// without medical access, and that the views pass automated accessibility checks.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ENTRY,
  FILE,
  HOME,
  MEMBERSHIP,
  PET,
  medicalEntryDetail,
  petDetail,
  petList,
  petMedical,
} from "@/pets/testing";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { MedicalAccessForm } from "./medical-access-form";
import { MedicalEntryView } from "./medical-entry-view";
import { PetMedicalSection } from "./pet-medical";
import { PetProfileView } from "./pet-profile";
import { PetsView } from "./pets-view";

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

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => reply(200, { outcome: "saved", revision: 3 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
  router.push.mockClear();
});

describe("the pets list", () => {
  it("shows each pet with species and age, and lets a manager add one by name", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(201, { outcome: "created", id: PET, revision: 1 }));
    const { container } = renderWithQuery(
      <PetsView homeId={HOME} list={petList()} today="2026-11-10" />,
    );
    const card = screen.getByTestId("pet-card");
    expect(card).toHaveTextContent("Miso");
    expect(card).toHaveTextContent("Cat");
    expect(card).toHaveTextContent("4 years, 7 months");
    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Add pet" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add pet" }));
    expect(await screen.findByText("Enter a value.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /Name/u }), "Pip");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add pet" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalled();
    });
    expect(sent("/api/v1/pets", "POST")[0]).toMatchObject({ homeId: HOME, name: "Pip" });
  });

  it("offers no Add pet to a member who may only view, in Dutch", () => {
    renderWithQuery(
      <PetsView homeId={HOME} list={petList({ access: "view" })} today="2026-11-10" />,
      "nl",
    );
    expect(screen.queryByTestId("pet-new")).not.toBeInTheDocument();
    expect(screen.getByTestId("pet-card")).toHaveTextContent("Kat");
  });
});

describe("a pet's profile", () => {
  it("shows Unknown apart from Not entered, and no medical hint", async () => {
    const { container } = renderWithQuery(
      <PetProfileView pet={petDetail({ access: "view", medicalAccess: null })} />,
    );
    expect(screen.getByTestId("pet-breed")).toHaveTextContent("Unknown");
    expect(screen.getAllByText("Not entered").length).toBeGreaterThan(0);
    expect(screen.queryByText(/medical/iu)).not.toBeInTheDocument();
    expect(screen.queryByTestId("pet-edit")).not.toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("saves an edited profile with its revision and Unknown fields", async () => {
    const user = userEvent.setup();
    renderWithQuery(<PetProfileView pet={petDetail()} />);
    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Sex"), "unknown");
    await user.clear(within(dialog).getByLabelText("Weight"));
    await user.type(within(dialog).getByLabelText("Weight"), "4,25");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent(`/api/v1/pets/${PET}`, "PATCH")).toHaveLength(1);
    });
    expect(sent(`/api/v1/pets/${PET}`, "PATCH")[0]).toMatchObject({
      revision: 2,
      profile: { sex: null, weight: 4.25, weightUnit: "kg", unknown: ["breed", "sex"] },
    });
  });

  it("refuses a future birth date at its field before sending", async () => {
    const user = userEvent.setup();
    renderWithQuery(<PetProfileView pet={petDetail()} />);
    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    const dialog = screen.getByRole("dialog");
    await user.clear(within(dialog).getByLabelText("Birth date"));
    await user.type(within(dialog).getByLabelText("Birth date"), "2027-01-01");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("This date cannot be in the future.")).toBeVisible();
    expect(sent(`/api/v1/pets/${PET}`, "PATCH")).toHaveLength(0);
  });

  it("shows a stale save and refreshes the page", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(409, { error: "stale", revision: 5 }));
    renderWithQuery(<PetProfileView pet={petDetail()} />);
    await user.click(screen.getByRole("button", { name: "Edit profile" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else changed this");
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe("the medical section", () => {
  it("shows None, Unknown, upcoming appointments and the history apart", async () => {
    const { container } = renderWithQuery(
      <PetMedicalSection pet={petDetail()} medical={petMedical()} />,
    );
    expect(screen.getByTestId("pet-allergies")).toHaveTextContent("None");
    expect(screen.getByTestId("pet-medications")).toHaveTextContent("Not entered");
    expect(screen.getByTestId("pet-upcoming")).toHaveTextContent("Dental check");
    expect(screen.getByTestId("pet-upcoming")).not.toHaveTextContent("Rabies");
    expect(screen.getByTestId("pet-history")).toHaveTextContent("Rabies booster");
    expect(screen.getByTestId("pet-history")).toHaveTextContent("1 document");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("offers no edit controls to a medical viewer", () => {
    renderWithQuery(
      <PetMedicalSection pet={petDetail()} medical={petMedical({ level: "view" })} />,
    );
    expect(screen.queryByTestId("pet-medical-edit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pet-entry-new")).not.toBeInTheDocument();
  });

  it("saves allergies as None and medications as entered", async () => {
    const user = userEvent.setup();
    renderWithQuery(<PetMedicalSection pet={petDetail()} medical={petMedical()} />);
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("Which medications and doses"),
      "Thyroid tablets",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent(`/api/v1/pets/${PET}/medical`, "PUT")).toHaveLength(1);
    });
    expect(sent(`/api/v1/pets/${PET}/medical`, "PUT")[0]).toMatchObject({
      revision: 1,
      details: {
        allergies: null,
        none: ["allergies"],
        medications: "Thyroid tablets",
        unknown: ["registration"],
      },
    });
  });

  it("adds an entry and opens it", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(201, { outcome: "created", id: ENTRY, revision: 1 }));
    renderWithQuery(<PetMedicalSection pet={petDetail()} medical={petMedical()} />);
    await user.click(screen.getByRole("button", { name: "Add entry" }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Type"), "vaccination");
    await user.type(within(dialog).getByLabelText("Title"), "Leptospirosis");
    await user.click(within(dialog).getByRole("button", { name: "Add entry" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalled();
    });
    expect(sent(`/api/v1/pets/${PET}/medical-entries`, "POST")[0]).toMatchObject({
      entry: { type: "vaccination", date: "2026-11-10", title: "Leptospirosis" },
    });
  });
});

describe("a medical entry", () => {
  it("lists its documents through the authorizing file route", async () => {
    const { container } = renderWithQuery(
      <MedicalEntryView entry={medicalEntryDetail({ level: "view" })} birthDate={null} />,
    );
    expect(screen.getByRole("link", { name: "certificate.pdf" })).toHaveAttribute(
      "href",
      `/api/v1/files/${FILE}/content`,
    );
    expect(screen.queryByTestId("pet-attachment-add")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pet-entry-edit")).not.toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("refuses a file of another type before uploading", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderWithQuery(<MedicalEntryView entry={medicalEntryDetail()} birthDate={null} />);
    await user.upload(
      screen.getByTestId("pet-attachment-input"),
      new File(["x"], "notes.txt", { type: "text/plain" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a JPEG, PNG or WebP");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("medical access", () => {
  it("saves a member's level", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(200, { outcome: "ok" }));
    const { container } = renderWithQuery(
      <MedicalAccessForm homeId={HOME} membershipId={MEMBERSHIP} memberName="Sam" level="none" />,
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.selectOptions(screen.getByLabelText("Access for Sam"), "view");
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Access for Sam was saved");
    expect(sent("/pet-medical-access", "PUT")[0]).toEqual({
      membershipId: MEMBERSHIP,
      level: "view",
    });
  });
});
