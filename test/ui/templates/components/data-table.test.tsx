import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  type Column,
  DataTable,
  namedColumns,
} from "#templates/components/data-table.tsx";

const columns: Column[] = [
  { header: "Name" },
  { class: "amount", className: "money", header: "Amount" },
];

describe("DataTable", () => {
  test("builds named text columns from translation keys", () => {
    expect(namedColumns("common.status")).toEqual([
      { header: t("common.name") },
      { header: t("common.status") },
    ]);
  });

  test("renders positional cells with their column classes", () => {
    expect(
      String(
        DataTable({
          columns,
          rows: [
            ["First", 10],
            ["Second", 20],
          ],
        }),
      ),
    ).toBe(
      '<div class="table-scroll"><table><thead><tr><th>Name</th>' +
        '<th class="col-amount money">Amount</th></tr></thead><tbody>' +
        '<tr><td>First</td><td class="col-amount money">10</td></tr>' +
        '<tr><td>Second</td><td class="col-amount money">20</td></tr>' +
        "</tbody></table></div>",
    );
  });

  test("passes table options to the shared shell", () => {
    expect(
      String(
        DataTable({
          bodyAttrs: { "data-test": "yes" },
          columns,
          foot: <tr>{<td>Total</td>}</tr>,
          rows: [["First", 10]],
          scrollClass: "dash-scroll",
          tableClass: "available",
        }),
      ),
    ).toBe(
      '<div class="table-scroll dash-scroll"><table class="available">' +
        '<thead><tr><th>Name</th><th class="col-amount money">Amount</th>' +
        '</tr></thead><tbody data-test="yes"><tr><td>First</td>' +
        '<td class="col-amount money">10</td></tr></tbody>' +
        "<tfoot><tr><td>Total</td></tr></tfoot></table></div>",
    );
  });

  test("renders an empty body when there are no rows", () => {
    expect(String(DataTable({ columns, rows: [] }))).toContain(
      "<tbody></tbody>",
    );
  });

  test("rejects a row with more cells than columns", () => {
    expect(() =>
      String(
        DataTable({
          columns: [{ header: "Only" }],
          rows: [["first", "extra"]],
        }),
      ),
    ).toThrow("DataTable row has more cells than columns");
  });

  test("renders pre-built rows as-is", () => {
    expect(
      String(
        DataTable({
          columns: [{ header: "H" }],
          rows: [<tr>{<td>pre</td>}</tr>],
        }),
      ),
    ).toContain("<tbody><tr><td>pre</td></tr></tbody>");
  });

  test("renders a pre-built body as raw markup", () => {
    expect(
      String(
        DataTable({
          columns: [{ header: "H" }],
          rows: "<tr><td>raw</td></tr>",
        }),
      ),
    ).toContain("<tbody><tr><td>raw</td></tr></tbody>");
  });
});
