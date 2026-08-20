/**
 * The holiday record page: the owner-only Edit and Actions surface under
 * /admin/holidays/:id. The mutation handlers live in holidays.ts, so these ask
 * what the page shows and what a rejected save keeps.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { holidayPage } from "#routes/admin/holiday-page.ts";
import { FormParams } from "#shared/form-data.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";
import { adminGet, getTestAuthSession } from "#test-utils/session.ts";

describeWithEnv("the holiday page", { db: true }, () => {
  test("opens on the edit form for the holiday named in the path", async () => {
    const holiday = await createTestHoliday({ name: "Bank Holiday" });

    const response = await adminGet(`/admin/holidays/${holiday.id}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`action="/admin/holidays/${holiday.id}/edit"`);
    expect(html).toContain("Bank Holiday");
  });

  test("marks the holidays list as the section it belongs to", async () => {
    const holiday = await createTestHoliday();

    const html = await (await adminGet(`/admin/holidays/${holiday.id}`)).text();

    expect(html).toContain(`<a class="active" href="/admin/holidays">`);
  });

  test("offers deleting the holiday on its actions tab", async () => {
    const holiday = await createTestHoliday();

    const response = await adminGet(`/admin/holidays/${holiday.id}/actions`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`href="/admin/holidays/${holiday.id}/delete"`);
    expect(html).toContain("Delete holiday");
  });

  test("answers 404 for a holiday that is not there", async () => {
    expect((await adminGet("/admin/holidays/99999")).status).toBe(404);
  });

  test("keeps a rejected save's dates and says why it was rejected", async () => {
    const holiday = await createTestHoliday();

    const response = await holidayPage.renderEditError(
      holiday.id,
      await getTestAuthSession(),
      new FormParams({ end_date: "2026-01-01", start_date: "2026-06-01" }),
      "End date is before the start date",
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("2026-06-01");
    expect(html).toContain("End date is before the start date");
  });
});
