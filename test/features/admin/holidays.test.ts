/**
 * The holidays area: the CRUD routes and the date rule they enforce. The
 * integration suite drives the same routes through the server; this is the
 * mirror the mutation gate runs against holidays.ts.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { holidays } from "#db/holidays.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { DEMO_HOLIDAY_NAMES } from "#shared/demo/samples.ts";
import { holidayRule } from "#shared/records/holidays.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
import { assertJson, expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";
import { adminFormPost, adminGet, apiRequest } from "#test-utils/session.ts";

describeWithEnv("holidays", { db: true }, () => {
  test("creates a holiday and shows it on the list page", async () => {
    const { response } = await adminFormPost("/admin/holidays", {
      end_date: "2027-01-02",
      name: "New Year",
      start_date: "2027-01-01",
    });

    await expectFlashRedirect("/admin/holidays/1", "Holiday created")(response);
    assertStringIncludes(
      await (await adminGet("/admin/holidays")).text(),
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
    assertStringIncludes(await response.text(), "2026-06-01");
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

describeWithEnv("holiday saves in demo mode", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  const storedName = async (id: number) =>
    (await holidays.table.read.one({ id }))?.name;

  const createHoliday = async (name: string) => {
    await adminFormPost("/admin/holidays", {
      end_date: "2027-01-02",
      name,
      start_date: "2027-01-01",
    });
    const [created] = await holidays.table.read.many();
    return created?.name;
  };

  const editHoliday = async (name: string) => {
    const holiday = await createTestHoliday({ name: "Before" });
    await adminFormPost(`/admin/holidays/${holiday.id}/edit`, {
      end_date: "2026-12-26",
      name,
      start_date: "2026-12-25",
    });
    return storedName(holiday.id);
  };

  test("stores a sample name in place of the typed one on create", async () => {
    setDemoModeForTest(true);
    expect(DEMO_HOLIDAY_NAMES).toContain(await createHoliday("Real Day"));
  });

  test("stores a sample name in place of the typed one on edit", async () => {
    setDemoModeForTest(true);
    expect(DEMO_HOLIDAY_NAMES).toContain(await editHoliday("Real Day"));
  });

  test("stores the typed name on create and edit while demo mode is off", async () => {
    expect(await createHoliday("Real Day")).toBe("Real Day");
    expect(await editHoliday("Typed Day")).toBe("Typed Day");
  });
});

describeWithEnv("the holiday rule", { db: true }, () => {
  const rule = (name: string, start: string, end: string) =>
    holidayRule({
      endDate: parseDateStringOrThrow(end, "the holiday rule end date"),
      name,
      startDate: parseDateStringOrThrow(start, "the holiday rule start date"),
    });

  test("rejects an end date before the start date", async () => {
    const error = await rule("Backwards", "2026-06-01", "2026-01-01");

    expect(error.ok ? null : error.error).toBe(
      "End date must be on or after the start date",
    );
  });

  test("rejects a name past the text box limit", async () => {
    const error = await rule("H".repeat(251), "2026-06-01", "2026-06-02");

    expect(error).toEqual({
      error: "Name must be 250 characters or fewer",
      ok: false,
    });
    expect((await rule("H".repeat(250), "2026-06-01", "2026-06-02")).ok).toBe(
      true,
    );
  });

  test("the API refuses a name that the form cannot save", async () => {
    await assertJson(
      apiRequest("/api/admin/holidays", {
        body: {
          end_date: "2027-01-02",
          name: "H".repeat(251),
          start_date: "2027-01-01",
        },
        method: "POST",
      }),
      400,
      (body: { error: string }) => {
        expect(body.error).toBe("Name must be 250 characters or fewer");
      },
    );
  });

  test("accepts a single day, where the two dates are equal", async () => {
    const error = await rule("One day", "2026-06-01", "2026-06-01");

    expect(error.ok).toBe(true);
  });
});
