import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  CollectionTable,
  type Column,
  type DataColumn,
  DataTable,
  dataTable,
  namedColumns,
  reorderColumn,
  reorderTable,
} from "#templates/components/data-table.tsx";
import { withEnv } from "#test-utils/env.ts";

type Row = { id: number; name: string; amount: number };

const columns: DataColumn<Row>[] = [
  { cell: (r) => <a href={`/r/${r.id}`}>{r.name}</a>, header: "Name" },
  {
    cell: (r) => r.amount,
    class: "amount",
    header: "Amount",
  },
];

const rows: Row[] = [
  { amount: 10, id: 1, name: "First" },
  { amount: 20, id: 2, name: "Second" },
];

const reorderOptions = (titles?: { down: string; up: string }) => ({
  action: (row: Row) => (direction: "up" | "down") =>
    `/r/${row.id}/${direction}` as const,
  header: "Order",
  ...(titles === undefined ? {} : { titles }),
});
const renderReorderColumn = (titles?: { down: string; up: string }): string =>
  String(dataTable<Row>([reorderColumn(reorderOptions(titles))])(rows));
const renderReorderTable = (): string =>
  String(reorderTable<Row>(reorderOptions(), columns, rows));

describe("dataTable", () => {
  test("builds named text columns from translation keys", () => {
    expect(namedColumns("common.status")).toEqual([
      { header: t("common.name") },
      { header: t("common.status") },
    ]);
  });

  test("declares header and cells in one column order", () => {
    const html = String(dataTable(columns)(rows));
    // Header order matches the column declaration.
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain('<th class="col-amount">Amount</th>');
    // Cells are rendered in declared order per row.
    expect(html).toContain('<a href="/r/1">First</a>');
    expect(html).toContain('<a href="/r/2">Second</a>');
  });

  test("applies the column-kind class to every matching cell", () => {
    const html = String(dataTable(columns)(rows));
    expect(html).toContain('<td class="col-amount">10</td>');
    expect(html).toContain('<td class="col-amount">20</td>');
    // Plain column has no class on its cells.
    expect(html).not.toContain('<td class="">');
  });

  test("renders an empty tbody when there are no rows", () => {
    const html = String(dataTable(columns)([]));
    expect(html).toContain("<tbody></tbody>");
    expect(html).toContain("<th>Name</th>");
  });

  test("passes scrollClass/tableClass/bodyAttrs through to DataTable", () => {
    const html = String(
      dataTable(columns)(rows, {
        bodyAttrs: { "data-test": "yes" },
        scrollClass: "dash-scroll",
        tableClass: "avail",
      }),
    );
    expect(html).toContain('class="table-scroll dash-scroll"');
    expect(html).toContain('<table class="avail">');
    expect(html).toContain('<tbody data-test="yes">');
  });

  test("passes the row index and full row list to the cell renderer", () => {
    let seen: { i: number; count: number } | null = null;
    const indexed = dataTable<Row>([
      {
        cell: (_r, i, all) => {
          seen = { count: all.length, i };
          return i;
        },
        header: "Ix",
      },
    ])(rows);
    String(indexed);
    expect(seen).toEqual({ count: 2, i: 1 });
  });

  test("applies row-specific attributes to a schema cell", () => {
    const html = String(
      dataTable<Row>([
        {
          cell: (row) => row.amount,
          cellAttrs: (row) => ({ title: `${row.name} amount` }),
          class: "amount",
          header: "Amount",
        },
      ])(rows),
    );
    expect(html).toContain(
      '<td class="col-amount" title="First amount">10</td>',
    );
    expect(html).toContain(
      '<td class="col-amount" title="Second amount">20</td>',
    );
  });

  test("renders a configured empty row across every schema column", () => {
    const html = String(dataTable(columns)([], { empty: "Nothing here" }));
    expect(html).toContain('<td colspan="2">Nothing here</td>');
    expect(html).not.toContain("<tbody></tbody>");
  });

  test("renders reorder actions and custom titles while writable", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = renderReorderColumn({ down: "Lower", up: "Raise" });

    expect(html).toContain('action="/r/1/down"');
    expect(html).toContain('title="Lower"');
    expect(html).toContain('action="/r/2/up"');
    expect(html).toContain('title="Raise"');
  });

  test("omits optional reorder titles", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = renderReorderColumn();

    expect(html).not.toContain(" title=");
  });

  test("removes the whole reorder column in read-only mode", () => {
    using _env = withEnv({
      READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
    });
    const html = renderReorderTable();

    expect(html).not.toContain("Order");
    expect(html).not.toContain("/down");
    expect(html).toContain("Name");
  });

  test("renders an empty reorder cell when its column is used read-only", () => {
    using _env = withEnv({
      READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
    });
    const html = renderReorderColumn();

    expect(html).toContain('<td class="col-reorder"></td>');
    expect(html).not.toContain("/down");
  });

  test("adds the reorder column while writable", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = renderReorderTable();

    expect(html).toContain("Order");
    expect(html).toContain('action="/r/1/down"');
  });

  // The full serialisation for the `columns`/`rows` fixtures, parameterised by
  // the optional <tfoot> — asserted exactly so a stray node fails.
  const dtTable = (foot = ""): string =>
    `<div class="table-scroll"><table>` +
    `<thead><tr><th>Name</th><th class="col-amount">Amount</th></tr></thead>` +
    `<tbody><tr><td><a href="/r/1">First</a></td>` +
    `<td class="col-amount">10</td></tr>` +
    `<tr><td><a href="/r/2">Second</a></td>` +
    `<td class="col-amount">20</td></tr></tbody>${foot}</table></div>`;

  test("wraps the table in a plain table-scroll div with no tfoot by default", () => {
    // No scrollClass/tableClass and no foot — the whole serialisation is fixed.
    expect(String(dataTable(columns)(rows))).toBe(dtTable());
  });

  test("renders the tfoot in its exact place when foot content is given", () => {
    const withFoot = String(
      dataTable(columns)(rows, { foot: <tr>{<td>Total</td>}</tr> }),
    );
    expect(withFoot).toBe(dtTable("<tfoot><tr><td>Total</td></tr></tfoot>"));
  });
});

describe("DataTable row shapes", () => {
  const cols: Column[] = [{ header: "H" }];
  // The full serialisation for a single "H" column, parameterised by the tbody
  // contents — asserted exactly so a stray or misplaced node fails the test.
  const table = (body: string): string =>
    `<div class="table-scroll"><table><thead><tr><th>H</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>`;

  test("wraps positional cell arrays in tr/td", () => {
    expect(String(DataTable({ columns: cols, rows: [["cell-a"]] }))).toBe(
      table("<tr><td>cell-a</td></tr>"),
    );
  });

  test("renders pre-built <tr> elements as-is", () => {
    expect(
      String(DataTable({ columns: cols, rows: [<tr>{<td>pre</td>}</tr>] })),
    ).toBe(table("<tr><td>pre</td></tr>"));
  });

  test("passes a pre-rendered HTML string straight into the tbody", () => {
    expect(
      String(DataTable({ columns: cols, rows: "<tr><td>raw</td></tr>" })),
    ).toBe(table("<tr><td>raw</td></tr>"));
  });
});

describe("CollectionTable", () => {
  const cols: Column[] = [{ header: "H" }];

  test("renders the empty message when there are no items", () => {
    expect(
      String(
        CollectionTable({
          columns: cols,
          emptyKey: "modifiers.no_modifiers",
          items: [],
          rows: [],
        }),
      ),
    ).toBe(`<p>${t("modifiers.no_modifiers")}</p>`);
  });

  test("renders the table with its rows when there are items", () => {
    expect(
      String(
        CollectionTable({
          columns: cols,
          emptyKey: "modifiers.no_modifiers",
          items: [{ id: 1 }],
          rows: [["cell-a"]],
        }),
      ),
    ).toBe(
      `<div class="table-scroll"><table><thead><tr><th>H</th></tr></thead>` +
        "<tbody><tr><td>cell-a</td></tr></tbody></table></div>",
    );
  });
});
