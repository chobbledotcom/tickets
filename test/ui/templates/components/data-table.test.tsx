import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type Column,
  type DataColumn,
  DataTable,
  dataTable,
} from "#templates/components/data-table.tsx";

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

describe("dataTable", () => {
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

  test("wraps the table in a plain table-scroll div by default", () => {
    const html = String(dataTable(columns)(rows));
    expect(html).toContain('<div class="table-scroll">');
  });

  test("renders a tfoot only when foot content is given", () => {
    expect(String(dataTable(columns)(rows))).not.toContain("<tfoot>");

    const withFoot = String(
      dataTable(columns)(rows, { foot: <tr>{<td>Total</td>}</tr> }),
    );
    expect(withFoot).toContain("<tfoot><tr><td>Total</td></tr></tfoot>");
  });
});

describe("DataTable row shapes", () => {
  const cols: Column[] = [{ header: "H" }];

  test("wraps positional cell arrays in tr/td", () => {
    const html = String(DataTable({ columns: cols, rows: [["cell-a"]] }));
    expect(html).toContain("<tbody><tr><td>cell-a</td></tr></tbody>");
  });

  test("renders pre-built <tr> elements as-is", () => {
    const html = String(
      DataTable({ columns: cols, rows: [<tr>{<td>pre</td>}</tr>] }),
    );
    expect(html).toContain("<tbody><tr><td>pre</td></tr></tbody>");
  });

  test("passes a pre-rendered HTML string straight into the tbody", () => {
    const html = String(
      DataTable({ columns: cols, rows: "<tr><td>raw</td></tr>" }),
    );
    expect(html).toContain("<tbody><tr><td>raw</td></tr></tbody>");
  });
});
