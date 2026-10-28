import type { Mock } from "vitest";

import { DELETE as deleteCategory, PATCH as patchCategory } from "./categories/[categoryId]/route";
import { PUT as completion } from "./items/[itemId]/completion/route";
import { GET as history } from "./items/[itemId]/history/route";
import { POST as moveItem } from "./items/[itemId]/move/route";
import { POST as startRecurrence } from "./items/[itemId]/recurrence/route";
import { DELETE as deleteItem, PATCH as patchItem } from "./items/[itemId]/route";
import { POST as transfer } from "./items/[itemId]/transfer/route";
import { POST as createCategory } from "./lists/[listId]/categories/route";
import { POST as clearCompleted } from "./lists/[listId]/clear-completed/route";
import { POST as addItems } from "./lists/[listId]/items/route";
import { POST as moveList } from "./lists/[listId]/move/route";
import { DELETE as deleteList, GET as getList, PATCH as patchList } from "./lists/[listId]/route";
import { GET as listLists, POST as createList } from "./lists/route";
import { PATCH as patchRecurrence } from "./recurrences/[recurrenceId]/route";
import { GET as widget } from "./widget/route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const OTHER_LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const ITEM = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const ITEM_2 = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";
const CATEGORY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0030";
const RULE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0050";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args?: Record<string, unknown>) =>
        Promise.resolve(state.rpc(name, args ?? {})),
    }),
}));
vi.mock("@/preferences/server", () => ({
  getEffectiveTimeZone: () => Promise.resolve({ timeZone: "Europe/Brussels", source: "chosen" }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function request(
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = sameOrigin,
): Request {
  return new Request(`https://madeora.example/api/v1/shopping${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const listParams = (listId: string) => ({ params: Promise.resolve({ listId }) });
const itemParams = (itemId: string) => ({ params: Promise.resolve({ itemId }) });

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

const detail = {
  id: LIST,
  homeId: HOME,
  name: "Groceries",
  archived: false,
  memberAccess: "edit",
  access: "edit",
  revision: 3,
  createdByMe: false,
  categories: [{ id: CATEGORY, name: "Zuivel", revision: 1 }],
  items: [
    {
      id: ITEM,
      name: "Melk",
      quantity: "1.5",
      unit: "l",
      packaging: null,
      notes: null,
      categoryId: CATEGORY,
      position: 1,
      completedAt: null,
      completedBy: null,
      recurrenceId: null,
      occurrenceOn: null,
      revision: 2,
      createdAt: "2026-10-28T08:00:00Z",
    },
  ],
  recurrences: [],
  destinations: [{ id: OTHER_LIST, name: "Drogist", position: 2 }],
};

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("shopping lists", () => {
  it("lists a context's lists after applying due recurring items", async () => {
    answers({
      advance_shopping: 0,
      list_shopping_lists: [
        {
          id: LIST,
          name: "Groceries",
          position: 1,
          archived: false,
          member_access: "check",
          access: "check",
          revision: 1,
          active_items: 4,
          completed_items: 2,
        },
      ],
    });
    const response = await listLists(request(`/lists?homeId=${HOME}`, "GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      lists: [
        {
          id: LIST,
          name: "Groceries",
          position: 1,
          archived: false,
          memberAccess: "check",
          access: "check",
          revision: 1,
          activeItems: 4,
          completedItems: 2,
        },
      ],
    });
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual([
      "advance_shopping",
      "list_shopping_lists",
    ]);
    expect(state.rpc).toHaveBeenCalledWith("list_shopping_lists", {
      p_home_id: HOME,
      p_archived: false,
    });
  });

  it("answers a Home the person is not in like one that does not exist", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    const response = await listLists(request(`/lists?homeId=${HOME}`, "GET"));
    expect(response.status).toBe(404);
  });

  it("refuses reads and changes without a verified identity", async () => {
    state.identity = null;
    expect((await listLists(request("/lists", "GET"))).status).toBe(401);
    expect(
      (await createList(request("/lists", "POST", { id: LIST, name: "Groceries", homeId: null })))
        .status,
    ).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a cross-site change before reading it", async () => {
    const response = await createList(
      request(
        "/lists",
        "POST",
        { id: LIST, name: "X", homeId: null },
        {
          origin: "https://evil.example",
          host: "madeora.example",
        },
      ),
    );
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("creates a list with the client's id, and answers a retry with the same list", async () => {
    answers({ create_shopping_list: [{ outcome: "created", revision: 1 }] });
    const response = await createList(
      request("/lists", "POST", { id: LIST, name: "  Groceries ", homeId: HOME }),
    );
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("create_shopping_list", {
      p_id: LIST,
      p_name: "Groceries",
      p_home_id: HOME,
    });
    answers({ create_shopping_list: [{ outcome: "exists", revision: 1 }] });
    expect(
      (await createList(request("/lists", "POST", { id: LIST, name: "Groceries", homeId: HOME })))
        .status,
    ).toBe(200);
  });

  it("refuses an invisible or too long list name", async () => {
    for (const name of ["​", "x".repeat(61), ""]) {
      const response = await createList(
        request("/lists", "POST", { id: LIST, name, homeId: null }),
      );
      expect(response.status, JSON.stringify(name)).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("reads one list only from its own context's address", async () => {
    answers({ advance_shopping: 0, get_shopping_list: detail });
    const found = await getList(request(`/lists/${LIST}?homeId=${HOME}`, "GET"), listParams(LIST));
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ id: LIST, items: [{ quantity: "1.5" }] });
    // The same list asked for as a Personal one: not found.
    const personal = await getList(request(`/lists/${LIST}`, "GET"), listParams(LIST));
    expect(personal.status).toBe(404);
    answers({ advance_shopping: 0, get_shopping_list: null });
    const missing = await getList(
      request(`/lists/${LIST}?homeId=${HOME}`, "GET"),
      listParams(LIST),
    );
    expect(missing.status).toBe(404);
    expect((await getList(request("/lists/nope", "GET"), listParams("nope"))).status).toBe(404);
  });

  it("updates settings with the revision, and answers a stale one with the current revision", async () => {
    answers({ update_shopping_list: [{ outcome: "saved", revision: 4 }] });
    const body = { revision: 3, name: "Weekly", memberAccess: "view", archived: true };
    const saved = await patchList(request(`/lists/${LIST}`, "PATCH", body), listParams(LIST));
    expect(saved.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("update_shopping_list", {
      p_list_id: LIST,
      p_expected_revision: 3,
      p_name: "Weekly",
      p_member_access: "view",
      p_archived: true,
    });
    answers({ update_shopping_list: [{ outcome: "conflict", revision: 7 }] });
    const stale = await patchList(request(`/lists/${LIST}`, "PATCH", body), listParams(LIST));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflict", revision: 7 });
    answers({ update_shopping_list: [{ outcome: "not_permitted", revision: null }] });
    expect(
      (await patchList(request(`/lists/${LIST}`, "PATCH", body), listParams(LIST))).status,
    ).toBe(403);
    expect(
      (
        await patchList(
          request(`/lists/${LIST}`, "PATCH", { ...body, memberAccess: "owner" }),
          listParams(LIST),
        )
      ).status,
    ).toBe(400);
  });

  it("deletes a list to the trash and moves lists relatively", async () => {
    answers({ delete_shopping_list: [{ outcome: "deleted", entry_id: ENTRY }] });
    const deleted = await deleteList(
      request(`/lists/${LIST}`, "DELETE", { revision: 3 }),
      listParams(LIST),
    );
    expect(await deleted.json()).toEqual({ id: LIST, entryId: ENTRY });
    answers({ move_shopping_list: "saved" });
    const moved = await moveList(
      request(`/lists/${LIST}/move`, "POST", { direction: "up" }),
      listParams(LIST),
    );
    expect(moved.status).toBe(200);
    expect(
      (
        await moveList(
          request(`/lists/${LIST}/move`, "POST", { direction: "top" }),
          listParams(LIST),
        )
      ).status,
    ).toBe(400);
  });
});

describe("shopping items", () => {
  it("adds rows with their own ids, quantities as decimal strings, per-row answers", async () => {
    answers({
      add_shopping_items: [
        { id: ITEM, outcome: "created" },
        { id: ITEM_2, outcome: "duplicate" },
      ],
    });
    const response = await addItems(
      request(`/lists/${LIST}/items`, "POST", {
        items: [
          { id: ITEM, name: "Pasta", quantity: "500", unit: "g" },
          { id: ITEM_2, name: "Melk" },
        ],
      }),
      listParams(LIST),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        { id: ITEM, outcome: "created" },
        { id: ITEM_2, outcome: "duplicate" },
      ],
    });
    expect(state.rpc).toHaveBeenCalledWith("add_shopping_items", {
      p_list_id: LIST,
      p_items: [
        {
          id: ITEM,
          name: "Pasta",
          quantity: "500",
          unit: "g",
          packaging: null,
          notes: null,
          categoryId: null,
          allowDuplicate: false,
        },
        {
          id: ITEM_2,
          name: "Melk",
          quantity: null,
          unit: null,
          packaging: null,
          notes: null,
          categoryId: null,
          allowDuplicate: false,
        },
      ],
    });
  });

  it("refuses floats, rounding, a unit without quantity, repeated ids and too many rows", async () => {
    const bodies = [
      { items: [{ id: ITEM, name: "Pasta", quantity: 0.5 }] },
      { items: [{ id: ITEM, name: "Pasta", quantity: "1.2345" }] },
      { items: [{ id: ITEM, name: "Pasta", quantity: "0" }] },
      { items: [{ id: ITEM, name: "Pasta", unit: "g" }] },
      { items: [{ id: ITEM, name: "Pasta", unit: "cup", quantity: "1" }] },
      {
        items: [
          { id: ITEM, name: "A" },
          { id: ITEM, name: "B" },
        ],
      },
      { items: [] },
    ];
    for (const body of bodies) {
      const response = await addItems(
        request(`/lists/${LIST}/items`, "POST", body),
        listParams(LIST),
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a list the person may not add to as a whole refusal", async () => {
    answers({ add_shopping_items: [{ id: ITEM, outcome: "not_permitted" }] });
    const response = await addItems(
      request(`/lists/${LIST}/items`, "POST", { items: [{ id: ITEM, name: "Pasta" }] }),
      listParams(LIST),
    );
    expect(response.status).toBe(403);
  });

  it("edits an item with its revision, leaving out cleared fields", async () => {
    answers({ update_shopping_item: [{ outcome: "saved", revision: 3 }] });
    const response = await patchItem(
      request(`/items/${ITEM}`, "PATCH", {
        revision: 2,
        name: "Melk",
        quantity: "1.25",
        unit: "l",
        packaging: null,
        notes: null,
        categoryId: null,
      }),
      itemParams(ITEM),
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("update_shopping_item", {
      p_item_id: ITEM,
      p_expected_revision: 2,
      p_name: "Melk",
      p_quantity: 1.25,
      p_unit: "l",
    });
    answers({ update_shopping_item: [{ outcome: "conflict", revision: 5 }] });
    const stale = await patchItem(
      request(`/items/${ITEM}`, "PATCH", {
        revision: 2,
        name: "Melk",
        quantity: null,
        unit: null,
        packaging: null,
        notes: null,
        categoryId: null,
      }),
      itemParams(ITEM),
    );
    expect(await stale.json()).toEqual({ error: "conflict", revision: 5 });
  });

  it("checks off set-to-state, sending the completion seen when reopening", async () => {
    answers({
      set_shopping_item_completed: [
        {
          outcome: "unchanged",
          completed_at: "2026-10-28T09:00:00Z",
          completed_by: { me: false, member: null },
        },
      ],
    });
    const done = await completion(
      request(`/items/${ITEM}/completion`, "PUT", { completed: true, seenCompletedAt: null }),
      itemParams(ITEM),
    );
    expect(await done.json()).toEqual({
      outcome: "unchanged",
      completedAt: "2026-10-28T09:00:00Z",
      completedBy: { me: false, member: null },
    });
    expect(state.rpc).toHaveBeenCalledWith("set_shopping_item_completed", {
      p_item_id: ITEM,
      p_completed: true,
    });
    answers({
      set_shopping_item_completed: [
        { outcome: "conflict", completed_at: null, completed_by: null },
      ],
    });
    const reopen = await completion(
      request(`/items/${ITEM}/completion`, "PUT", {
        completed: false,
        seenCompletedAt: "2026-10-28T09:00:00Z",
      }),
      itemParams(ITEM),
    );
    expect(reopen.status).toBe(409);
    expect(state.rpc).toHaveBeenLastCalledWith("set_shopping_item_completed", {
      p_item_id: ITEM,
      p_completed: false,
      p_seen_completed_at: "2026-10-28T09:00:00Z",
    });
  });

  it("transfers within a context, mapping each refusal", async () => {
    const body = {
      mode: "copy",
      destinationListId: OTHER_LIST,
      revision: 2,
      categoryId: null,
      keepCompleted: true,
      allowDuplicate: false,
      copyId: ITEM_2,
    };
    answers({ transfer_shopping_item: [{ outcome: "copied", item_id: ITEM_2 }] });
    const copied = await transfer(
      request(`/items/${ITEM}/transfer`, "POST", body),
      itemParams(ITEM),
    );
    expect(await copied.json()).toEqual({ outcome: "copied", itemId: ITEM_2 });
    const cases: [string, number, string][] = [
      ["duplicate", 409, "duplicate"],
      ["same_list", 409, "same-list"],
      ["destination_unavailable", 409, "destination-unavailable"],
      ["not_permitted", 403, "not-permitted"],
      ["conflict", 409, "conflict"],
      ["invalid_category", 409, "invalid-category"],
      ["limit_reached", 409, "limit-reached"],
    ];
    for (const [outcome, status, error] of cases) {
      answers({ transfer_shopping_item: [{ outcome, item_id: null }] });
      const response = await transfer(
        request(`/items/${ITEM}/transfer`, "POST", body),
        itemParams(ITEM),
      );
      expect(response.status, outcome).toBe(status);
      expect(await response.json(), outcome).toMatchObject({ error });
    }
    // A copy needs its client id; a move must not carry one.
    const noCopyId = await transfer(
      request(`/items/${ITEM}/transfer`, "POST", { ...body, copyId: null }),
      itemParams(ITEM),
    );
    expect(noCopyId.status).toBe(400);
  });

  it("moves, deletes and clears items", async () => {
    answers({ move_shopping_item: "unchanged" });
    expect(
      (
        await moveItem(
          request(`/items/${ITEM}/move`, "POST", { direction: "down" }),
          itemParams(ITEM),
        )
      ).status,
    ).toBe(200);
    answers({ delete_shopping_item: [{ outcome: "deleted", entry_id: ENTRY }] });
    const deleted = await deleteItem(request(`/items/${ITEM}`, "DELETE", {}), itemParams(ITEM));
    expect(await deleted.json()).toEqual({ id: ITEM, entryId: ENTRY });
    answers({
      clear_completed_shopping_items: [
        { outcome: "cleared", cleared: 2, skipped: 1, entry_id: ENTRY },
      ],
    });
    const cleared = await clearCompleted(
      request(`/lists/${LIST}/clear-completed`, "POST", { itemIds: [ITEM, ITEM_2] }),
      listParams(LIST),
    );
    expect(await cleared.json()).toEqual({
      outcome: "cleared",
      cleared: 2,
      skipped: 1,
      entryId: ENTRY,
    });
  });

  it("reads an item's history, and answers an invisible item as not found", async () => {
    answers({
      shopping_item_history: [
        { kind: "recurred", at: "2026-10-28T00:00:00Z", actor: null, other_list_name: null },
      ],
    });
    const found = await history(request(`/items/${ITEM}/history`, "GET"), itemParams(ITEM));
    expect(await found.json()).toEqual({
      entries: [{ kind: "recurred", at: "2026-10-28T00:00:00Z", actor: null, otherListName: null }],
    });
    answers({ shopping_item_history: [] });
    expect((await history(request(`/items/${ITEM}/history`, "GET"), itemParams(ITEM))).status).toBe(
      404,
    );
  });
});

describe("categories, recurring items and the widget", () => {
  it("creates, renames, moves and removes categories", async () => {
    answers({ create_shopping_category: [{ outcome: "duplicate_name", revision: null }] });
    const duplicate = await createCategory(
      request(`/lists/${LIST}/categories`, "POST", { id: CATEGORY, name: "zuivel" }),
      listParams(LIST),
    );
    expect(await duplicate.json()).toEqual({ error: "duplicate-name" });
    const category = { params: Promise.resolve({ categoryId: CATEGORY }) };
    answers({ move_shopping_category: "saved" });
    expect(
      (
        await patchCategory(
          request(`/categories/${CATEGORY}`, "PATCH", { direction: "up" }),
          category,
        )
      ).status,
    ).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("move_shopping_category", {
      p_id: CATEGORY,
      p_direction: "up",
    });
    answers({ delete_shopping_category: [{ outcome: "deleted", moved_items: 3 }] });
    const removed = await deleteCategory(
      request(`/categories/${CATEGORY}`, "DELETE", { revision: 1 }),
      category,
    );
    expect(await removed.json()).toEqual({ id: CATEGORY, movedItems: 3 });
  });

  it("starts a repeat with the person's timezone, refusing a checked-off item", async () => {
    answers({
      start_shopping_recurrence: [{ outcome: "created", revision: 1, next_on: "2026-11-02" }],
    });
    const body = {
      id: RULE,
      schedule: { frequency: "weekly", weekdays: [1, 4], monthDay: null, startOn: null },
    };
    const started = await startRecurrence(
      request(`/items/${ITEM}/recurrence`, "POST", body),
      itemParams(ITEM),
    );
    expect(started.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("start_shopping_recurrence", {
      p_item_id: ITEM,
      p_id: RULE,
      p_frequency: "weekly",
      p_weekdays: [1, 4],
      p_time_zone: "Europe/Brussels",
    });
    answers({
      start_shopping_recurrence: [{ outcome: "completed", revision: null, next_on: null }],
    });
    const completed = await startRecurrence(
      request(`/items/${ITEM}/recurrence`, "POST", body),
      itemParams(ITEM),
    );
    expect(await completed.json()).toEqual({ error: "completed" });
    for (const schedule of [
      { frequency: "weekly", weekdays: [], monthDay: null, startOn: null },
      { frequency: "monthly", weekdays: null, monthDay: 32, startOn: null },
      { frequency: "daily", weekdays: [1], monthDay: null, startOn: null },
    ]) {
      const invalid = await startRecurrence(
        request(`/items/${ITEM}/recurrence`, "POST", { id: RULE, schedule }),
        itemParams(ITEM),
      );
      expect(invalid.status, JSON.stringify(schedule)).toBe(400);
    }
  });

  it("pauses a rule with its revision", async () => {
    answers({
      update_shopping_recurrence: [{ outcome: "saved", revision: 2, next_on: "2026-11-02" }],
    });
    const response = await patchRecurrence(
      request(`/recurrences/${RULE}`, "PATCH", { revision: 1, action: "pause" }),
      { params: Promise.resolve({ recurrenceId: RULE }) },
    );
    expect(await response.json()).toEqual({ id: RULE, revision: 2, nextOn: "2026-11-02" });
    expect(state.rpc).toHaveBeenCalledWith("update_shopping_recurrence", {
      p_id: RULE,
      p_expected_revision: 1,
      p_action: "pause",
    });
  });

  it("reads widget rows for the chosen lists in order", async () => {
    const data = {
      lists: [{ id: LIST, name: "Groceries", position: 1, access: "check" }],
      unavailable: 1,
      total: 7,
      items: [
        {
          id: ITEM,
          listId: LIST,
          name: "Melk",
          quantity: "2",
          unit: null,
          packaging: null,
          revision: 1,
        },
      ],
    };
    answers({ advance_shopping: 0, shopping_widget: data });
    const response = await widget(
      request(`/widget?homeId=${HOME}&listIds=${LIST},${OTHER_LIST}&limit=5`, "GET"),
    );
    expect(await response.json()).toEqual(data);
    expect(state.rpc).toHaveBeenCalledWith("shopping_widget", {
      p_home_id: HOME,
      p_list_ids: [LIST, OTHER_LIST],
      p_limit: 5,
    });
    for (const query of [
      `listIds=${LIST},${LIST}&limit=5`,
      `listIds=${LIST}&limit=7`,
      `listIds=nope&limit=5`,
    ]) {
      expect((await widget(request(`/widget?${query}`, "GET"))).status, query).toBe(400);
    }
  });
});
