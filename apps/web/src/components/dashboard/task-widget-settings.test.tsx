import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { widgetRegistry, type WidgetConfigs } from "@/dashboard/widgets";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { TaskWidgetSettings } from "./task-widget-settings";

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const ARCHIVED = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const GONE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0012";
const LABEL = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0030";

const options = {
  lists: [
    { id: LIST, name: "Groceries", archived: false },
    { id: ARCHIVED, name: "Old", archived: true },
  ],
  labels: [{ id: LABEL, name: "Garden", color: null }],
  members: [
    { id: "self", name: "Robin", isSelf: true },
    { id: MEMBER, name: "Sam", isSelf: false },
  ],
};

const fetchMock = vi.fn<(url: string) => Promise<Response>>();
const changes: WidgetConfigs["tasks"][] = [];

function Harness({
  homeId,
  initial = {},
}: {
  readonly homeId: string | null;
  readonly initial?: Partial<WidgetConfigs["tasks"]>;
}) {
  const [config, setConfig] = useState(widgetRegistry.tasks.config.parse(initial));
  return (
    <TaskWidgetSettings
      config={config}
      homeId={homeId}
      onChange={(next) => {
        changes.push(next);
        setConfig(next);
      }}
    />
  );
}

beforeEach(() => {
  changes.length = 0;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(options), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TaskWidgetSettings", () => {
  it("offers the context's active lists, filters and Home assignees, accessibly", async () => {
    const { container } = renderWithQuery(<Harness homeId={HOME} />);
    const list = await screen.findByRole("combobox", { name: "List" });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/tasks/options?homeId=${HOME}`,
      expect.objectContaining({ method: "GET" }),
    );
    const listNames = [...(list as HTMLSelectElement).options].map((o) => o.text);
    expect(listNames).toEqual(["All Tasks", "Groceries"]);
    const assignee = screen.getByRole("combobox", { name: "Assigned to" });
    expect([...(assignee as HTMLSelectElement).options].map((o) => o.text)).toContain("Sam");
    expect([...(assignee as HTMLSelectElement).options].map((o) => o.text)).not.toContain("Robin");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("saves typed choices: list, timing, priorities, labels, a member and the count", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness homeId={HOME} />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "List" }), LIST);
    await user.selectOptions(screen.getByRole("combobox", { name: /^Timing/ }), "due_week");
    await user.click(screen.getByRole("checkbox", { name: "Urgent" }));
    await user.click(screen.getByRole("checkbox", { name: "Garden" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Assigned to" }), MEMBER);
    await user.selectOptions(screen.getByRole("combobox", { name: "Tasks to show" }), "15");
    const last = changes.at(-1);
    expect(last).toMatchObject({
      listId: LIST,
      when: "due_week",
      priorities: ["urgent"],
      labelIds: [LABEL],
      assignee: "member",
      memberId: MEMBER,
      count: 15,
    });
    expect(widgetRegistry.tasks.config.safeParse(last).success).toBe(true);
  });

  it("has no assignee setting in the Personal space", async () => {
    renderWithQuery(<Harness homeId={null} />);
    await screen.findByRole("combobox", { name: "List" });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/tasks/options", expect.anything());
    expect(screen.queryByRole("combobox", { name: "Assigned to" })).toBeNull();
  });

  it("names a list, label or member that no longer exists instead of picking another", async () => {
    renderWithQuery(
      <Harness
        homeId={HOME}
        initial={{ listId: GONE, labelIds: [GONE], assignee: "member", memberId: GONE }}
      />,
    );
    const list = await screen.findByRole("combobox", { name: "List" });
    expect(list).toHaveDisplayValue("A list that is no longer available");
    expect(screen.getByRole("combobox", { name: "Assigned to" })).toHaveDisplayValue(
      "A former member",
    );
    expect(screen.getByText(/Some chosen labels no longer exist/)).toBeInTheDocument();
    expect(changes).toEqual([]);
  });

  it("says when the options cannot be loaded", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "failed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    renderWithQuery(<Harness homeId={HOME} />);
    await waitFor(() => {
      expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
    });
  });
});
