import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { PUBLIC_API_ENDPOINTS } from "#shared/admin-api-example/public.ts";
import { FieldTable } from "#templates/admin/api-field-table.tsx";
import { adminApiDocsPage } from "#templates/admin/api-keys.tsx";
import { ADMIN_API_ENDPOINTS } from "#test/shared/admin-api-example/helpers.ts";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import {
  expectIncludesAll,
  tableRowContaining,
} from "#test-utils/assertions.ts";

describe("FieldTable", () => {
  beforeAll(setupAdminPageTest);

  test("shows each field with its value, and its default", () => {
    const html = String(
      <FieldTable
        rows={[
          {
            defaultJson: null,
            key: "closes_at",
            required: false,
            value: { form: "or_null", of: { form: "time" } },
          },
          {
            defaultJson: "1",
            key: "max_quantity",
            required: true,
            value: { form: "whole_number", min: 1 },
          },
          {
            defaultJson: null,
            key: "items",
            required: false,
            value: {
              form: "list_of",
              of: { form: "object", names: ["item_id", "item_type"] },
            },
          },
        ]}
      />,
    );

    expectIncludesAll(html, [
      "<strong>Fields:</strong>",
      "<th>Field</th>",
      "<th>Value</th>",
      "<th>Required</th>",
      "<th>Default</th>",
    ]);
    expectIncludesAll(tableRowContaining(html, "closes_at"), [
      "<code>closes_at</code>",
      "UTC date and time, such as 2040-03-01T09:00:00.000Z, or null",
      "<td>No</td>",
      "<td></td>",
    ]);
    expectIncludesAll(tableRowContaining(html, "max_quantity"), [
      "Whole number, 1 or more",
      "<td>Yes</td>",
      "<code>1</code>",
    ]);
    expectIncludesAll(tableRowContaining(html, "items"), [
      "List of: Object with item_id, item_type",
    ]);
  });

  test("the documentation page finds words for every documented field", () => {
    const html = adminApiDocsPage(
      OWNER_SESSION,
      PUBLIC_API_ENDPOINTS,
      ADMIN_API_ENDPOINTS,
    );

    expectIncludesAll(html, [
      "<code>closes_at</code>",
      "Whole number from 1 to 90",
      "Date, as YYYY-MM-DD",
      "Contact field names with commas between them",
      "Object of day counts, each with its price in minor units",
      "One of: standard, daily",
      "Price in minor units, as a whole number",
      "<td>true or false</td>",
      "<td>Number, or null</td>",
      "or empty text",
    ]);
  });
});
