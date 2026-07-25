import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { RECALCULATE_FIELD_NAME } from "#shared/recalculate-fields.ts";
import {
  adminRecalculatePage,
  type RecalculateRow,
} from "#templates/admin/recalculate.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

const rows: RecalculateRow[] = [
  {
    current: "3 stored",
    label: "Booked places",
    name: "booked_quantity",
    recalculated: "5 counted",
  },
  {
    current: "7 stored",
    label: "Tickets sold",
    name: "tickets_count",
    recalculated: "8 counted",
  },
];

const renderPage = (error?: string, success?: string): string =>
  adminRecalculatePage({
    action: "/admin/synthetic/recalculate",
    active: "/admin/settings",
    currentLabel: "Stored value",
    description: "Choose totals & save.",
    error,
    recalculatedLabel: "Counted value",
    rows,
    session: OWNER_SESSION,
    submitLabel: "Apply selected totals",
    success,
    title: "Recalculate synthetic totals",
  });

describe("admin recalculate page", () => {
  beforeAll(setupAdminPageTest);

  test("renders each selectable row in order with current and counted values", () => {
    const html = renderPage();

    expect(html).toContain('action="/admin/synthetic/recalculate"');
    expect(html).toContain("<p>Choose totals &amp; save.</p>");
    expect(html).toContain(
      "<th></th><th>Stored value</th><th>Counted value</th>",
    );
    expect(html).toContain(
      `<th scope="row"><label><input name="${RECALCULATE_FIELD_NAME}" type="checkbox" value="booked_quantity"> Booked places</label></th>`,
    );
    expect(html).toContain("<td>3 stored</td><td>5 counted</td>");
    expect(html).toContain(
      `<th scope="row"><label><input name="${RECALCULATE_FIELD_NAME}" type="checkbox" value="tickets_count"> Tickets sold</label></th>`,
    );
    expect(html).toContain("<td>7 stored</td><td>8 counted</td>");
    expect(html.indexOf('value="booked_quantity"')).toBeLessThan(
      html.indexOf('value="tickets_count"'),
    );
    expect(html).toContain("Apply selected totals");
  });

  test("renders a recalculation error", () => {
    const html = renderPage("Choose at least one total.");

    expect(html).toContain(
      '<div autofocus class="error" role="alert" tabindex="-1">Choose at least one total.</div>',
    );
    expect(html).not.toContain('class="success"');
  });

  test("renders a recalculation success notice", () => {
    const html = renderPage(undefined, "Totals recalculated.");

    expect(html).toContain(
      '<div class="success" role="alert">Totals recalculated.</div>',
    );
    expect(html).not.toContain('class="error"');
  });
});
