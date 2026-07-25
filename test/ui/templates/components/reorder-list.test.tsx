import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { TableColumn } from "#shared/tables/definition.ts";
import {
  itemsOrEmptyNote,
  reorderableListPage,
  reorderCountTable,
} from "#templates/components/reorder-list.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";

type Item = { count: number; id: number; name: string };

const ITEMS: Item[] = [
  { count: 3, id: 1, name: "First" },
  { count: 5, id: 2, name: "Second" },
];

const COLUMNS: readonly TableColumn<Item>[] = [
  { cell: (item) => item.name, header: "Name", key: "name" },
  {
    cell: (item) => item.count,
    class: "quantity",
    header: "Uses",
    key: "uses",
  },
];

const countTable = (items: Item[]): string =>
  String(
    reorderCountTable({
      count: (item) => item.count,
      countHeader: "Uses",
      editHref: (item) => `/things/${item.id}/edit`,
      emptyText: "No things yet",
      items,
      label: (item) => item.name,
      labelHeader: "Thing",
      moveAction: (item) => (direction) =>
        `/things/${item.id}/move-${direction}`,
      orderLabel: "Order",
    }),
  );

const listPage = (items: Item[], error?: string): string =>
  reorderableListPage({
    addFormHtml: '<label>Name<input name="name"></label>',
    addLabel: "Add thing",
    basePath: "/things",
    columns: COLUMNS,
    emptyText: "Nothing here",
    error,
    guideHref: "/admin/guide#things",
    guideLabel: "Things guide",
    items,
    newFormId: "new-thing",
    orderLabel: "Order",
    session: OWNER_SESSION,
    title: "Things",
  });

describe("reorder list components", () => {
  beforeAll(setupAdminPageTest);

  test("chooses the exact empty note or supplied present renderer", () => {
    expect(
      String(itemsOrEmptyNote([], <em>Empty</em>, () => <strong>Rows</strong>)),
    ).toBe("<p><em>Empty</em></p>");
    expect(
      String(
        itemsOrEmptyNote(ITEMS, "Empty", (items) => (
          <strong>{items.map((item) => item.name).join(" + ")}</strong>
        )),
      ),
    ).toBe("<strong>First + Second</strong>");
  });

  test("renders the reorder count table empty state", () => {
    expect(countTable([])).toBe("<p><em>No things yet</em></p>");
  });

  test("renders linked count rows and boundary-aware moves when writable", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = countTable(ITEMS);

    expect(html).toContain(
      '<th class="col-reorder">Order</th><th>Thing</th><th class="col-quantity">Uses</th>',
    );
    expect(html).toContain('<a href="/things/1/edit">First</a>');
    expect(html).toContain('<td class="col-quantity">3</td>');
    expect(html).toContain('action="/things/1/move-down"');
    expect(html).not.toContain('action="/things/1/move-up"');
    expect(html).toContain('action="/things/2/move-up"');
    expect(html).not.toContain('action="/things/2/move-down"');
  });

  test("keeps count rows but removes links and moves when read-only", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = countTable(ITEMS);

    expect(html).toContain("<td>First</td>");
    expect(html).toContain('<td class="col-quantity">5</td>');
    expect(html).not.toContain('href="/things/1/edit"');
    expect(html).not.toContain('class="col-reorder"');
    expect(html).not.toContain("/move-");
  });

  test("renders the writable list page form, empty note, error, and guide", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = listPage([], "Name is required");

    expect(html).toContain("Name is required");
    expect(html).toContain(
      '<form action="/things" autocomplete="off" method="POST" id="new-thing">',
    );
    expect(html).toContain('<label>Name<input name="name"></label>');
    expect(html).toContain("Add thing");
    expect(html).toContain("<p><em>Nothing here</em></p>");
    expect(html).toContain('href="/admin/guide#things"');
    expect(html).toContain("<span>Things guide</span>");
  });

  test("renders populated list rows through the declared columns and routes", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = listPage(ITEMS);

    expect(html).toContain('<th>Name</th><th class="col-quantity">Uses</th>');
    expect(html).toContain('<td>First</td><td class="col-quantity">3</td>');
    expect(html).toContain('action="/things/1/move-down"');
    expect(html).toContain('action="/things/2/move-up"');
    expect(html).not.toContain("Nothing here");
  });

  test("hides list-page create and reorder forms when read-only", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = listPage([ITEMS[0]!]);

    expect(html).toContain("<td>First</td>");
    expect(html).toContain("Things guide");
    expect(html).not.toContain('id="new-thing"');
    expect(html).not.toContain("Add thing");
    expect(html).not.toContain('class="col-reorder"');
    expect(html).not.toContain("/move-");
  });
});
