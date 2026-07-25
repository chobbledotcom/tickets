import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { defineTable } from "#shared/tables/definition.ts";
import {
  renderColumnReference,
  renderTable,
  tableColumnText,
} from "#templates/components/table.tsx";

describe("typed table rendering", () => {
  test("ignores non-text and empty cell classes through the renderer", () => {
    const table = defineTable<{
      className: boolean | number | string | undefined;
      value: string;
    }>([
      {
        cell: (row) => row.value,
        cellAttrs: (row) => ({ class: row.className }),
        header: "Value",
        key: "value",
      },
    ]);
    const html = String(
      renderTable(
        table,
        ["", 4, true, false, undefined].map((className, index) => ({
          className,
          value: `Value ${index}`,
        })),
      ),
    );

    expect(html).toContain(
      "<tbody><tr><td>Value 0</td></tr><tr><td>Value 1</td></tr><tr><td>Value 2</td></tr><tr><td>Value 3</td></tr><tr><td>Value 4</td></tr></tbody>",
    );
  });

  test("uses the label as the default column header", () => {
    const defaults = tableColumnText(
      () => "Name",
      () => "Stored name",
    );
    expect(defaults.label()).toBe("Name");
    expect(defaults.description()).toBe("Stored name");
    expect(defaults.header()).toBe("Name");
    expect(
      tableColumnText(
        () => "Name",
        () => "Stored name",
        () => "Listing name",
      ).header(),
    ).toBe("Listing name");
  });

  test("renders row values, attributes, classes, and an empty state", () => {
    const table = defineTable<{ amount: number }>([
      {
        cell: (row) => row.amount,
        cellAttrs: () => ({ class: "highlight", title: "Exact amount" }),
        class: "amount",
        header: "Amount",
        key: "amount",
      },
    ]);

    expect(String(renderTable(table, [{ amount: 12 }]))).toContain(
      '<td class="col-amount highlight" title="Exact amount">12</td>',
    );
    expect(String(renderTable(table, [], { empty: "None" }))).toContain(
      '<td colspan="1">None</td>',
    );
  });

  test("renders attributes derived from each row", () => {
    const table = defineTable<{ active: boolean; name: string }>([
      { cell: (row) => row.name, header: "Name", key: "name" },
    ]);

    expect(
      String(
        renderTable(table, [{ active: false, name: "Hidden" }], {
          rowAttrs: (row) =>
            row.active ? {} : { class: "inactive-row", "data-active": "false" },
        }),
      ),
    ).toContain(
      '<tr class="inactive-row" data-active="false"><td>Hidden</td></tr>',
    );
  });

  test("renders semantic row headers", () => {
    const table = defineTable<{ label: string; value: string }>([
      {
        cell: (row) => row.label,
        header: "Field",
        key: "label",
        rowHeader: true,
      },
      { cell: (row) => row.value, header: "Value", key: "value" },
    ]);

    expect(
      String(renderTable(table, [{ label: "Name", value: "Alice" }])),
    ).toContain('<th scope="row">Name</th><td>Alice</td>');
  });

  test("renders only documented columns in the reference", () => {
    const table = defineTable<{ name: string }>([
      {
        cell: (row) => row.name,
        description: "Stored name",
        header: "Name",
        key: "name",
        label: "Name",
      },
      { cell: () => "hidden", header: "Internal", key: "internal" },
    ]);

    const html = String(renderColumnReference(table));
    expect(html).toContain(`<th>${t("guide.table_reference.tag")}</th>`);
    expect(html).toContain(`<th>${t("guide.table_reference.label")}</th>`);
    expect(html).toContain(
      `<th>${t("guide.table_reference.description")}</th>`,
    );
    expect(html).toContain("{{name}}");
    expect(html).toContain("Stored name");
    expect(html).not.toContain("{{internal}}");
  });
});
