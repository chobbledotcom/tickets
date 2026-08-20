/**
 * The holidays area: the CRUD routes and the date rule they enforce. The
 * integration suite drives the same routes through the server; this is the
 * mirror the mutation gate runs against holidays.ts.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { holidays } from "#db/holidays.ts";
import { validateDateRange } from "#routes/admin/holidays.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("holidays", { db: true }, () => {
  test("creates a holiday and shows it on the list page", async () => {
    const { response } = await adminFormPost("/admin/holidays", {
      end_date: "2027-01-02",
      name: "New Year",
      start_date: "2027-01-01",
    });

    await expectFlashRedirect("/admin/holidays/1", "Holiday created")(response);
    expect(await (await adminGet("/admin/holidays")).text()).toContain(
      "New Year",
    );
  });

  test("sends the operator to the holiday's own page after an edit", async () => {
    const holiday = await createTestHoliday({ name: "Rename Me" });

    const { response } = await adminFormPost(
      `/admin/holidays/${holiday.id}/edit`,
      { end_date: "2026-12-26", name: "Renamed", start_date: "2026-12-25" },
    );

    await expectFlashRedirect(
      `/admin/holidays/${holiday.id}`,
      "Holiday updated",
    )(response);
    expect((await holidays.table.read.one({ id: holiday.id }))?.name).toBe(
      "Renamed",
    );
  });

  test("keeps the submitted dates when a save is rejected", async () => {
    const holiday = await createTestHoliday();

    const { response } = await adminFormPost(
      `/admin/holidays/${holiday.id}/edit`,
      { end_date: "2026-01-01", name: "Backwards", start_date: "2026-06-01" },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("2026-06-01");
  });

  test("deletes a holiday and drops it from the list", async () => {
    const holiday = await createTestHoliday({ name: "Spare Day" });

    const { response } = await adminFormPost(
      `/admin/holidays/${holiday.id}/delete`,
      { confirm_identifier: "Spare Day" },
    );

    await expectFlashRedirect("/admin/holidays", "Holiday deleted")(response);
    expect(await holidays.table.read.one({ id: holiday.id })).toBe(null);
  });
});

describeWithEnv("the holiday date rule", { db: true }, () => {
  test("rejects an end date before the start date", async () => {
    const error = await validateDateRange({
      endDate: "2026-01-01",
      name: "Backwards",
      startDate: "2026-06-01",
    });

    expect(error).toBe("End date must be on or after the start date");
  });

  test("accepts a single day, where the two dates are equal", async () => {
    const error = await validateDateRange({
      endDate: "2026-06-01",
      name: "One day",
      startDate: "2026-06-01",
    });

    expect(error).toBe(null);
  });
});
