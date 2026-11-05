import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Holiday } from "#db/holidays.ts";
import {
  adminHolidaysPage,
  getHolidayPages,
  HolidayEditPanel,
} from "#templates/admin/holidays.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { withEnv } from "#test-utils/env.ts";

const holiday: Holiday = {
  end_date: "2026-12-26",
  id: 42,
  name: "Christmas",
  start_date: "2026-12-25",
};

describe("holiday templates", () => {
  beforeAll(setupAdminPageTest);

  describe("adminHolidaysPage (resource factory list page)", () => {
    test("renders the add-holiday action and guide link in the action row", () => {
      const html = adminHolidaysPage([holiday], OWNER_SESSION);
      expectIncludesAll(html, [
        'href="/admin/holidays/new"',
        "Add holiday",
        'href="/admin/guide#holidays"',
      ]);
    });

    test("renders the table with name links and start/end columns", () => {
      const html = adminHolidaysPage([holiday], OWNER_SESSION);
      expectIncludesAll(html, [
        '<a class="active" href="/admin/holidays">Holidays</a>',
        'href="/admin/holidays/42"',
        "Christmas",
        "2026-12-25",
        "2026-12-26",
      ]);
    });

    test("renders the empty state when there are no holidays", () => {
      const html = adminHolidaysPage([], OWNER_SESSION);
      // The empty-state paragraph; assert no edit links (the only /admin/holidays
      // links are the nav link and the add action).
      assertStringIncludes(html, "No holidays configured");
      assert(!html.includes('href="/admin/holidays/42"'));
    });

    test("renders the success flash when a success message is passed", () => {
      const html = adminHolidaysPage([], OWNER_SESSION, "Holiday deleted");
      assertStringIncludes(html, "Holiday deleted");
    });

    test("shows holiday data without write links in read-only mode", () => {
      using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
      const html = adminHolidaysPage([holiday], OWNER_SESSION);
      assertStringIncludes(html, "Christmas");
      assert(!html.includes('href="/admin/holidays/new"'));
      assert(!html.includes('href="/admin/holidays/42"'));
    });
  });

  describe("holidayPages.newPage (resource factory new page)", () => {
    test("renders the create form posting to the base path with the add fields", () => {
      const html = getHolidayPages().newPage(OWNER_SESSION);
      expectIncludesAll(html, [
        'action="/admin/holidays"',
        'name="name"',
        'name="start_date"',
        'name="end_date"',
        // Submit button uses the create label and plus icon.
        "Create holiday",
      ]);
    });

    test("renders the error flash when an error is passed", () => {
      const html = getHolidayPages().newPage(
        OWNER_SESSION,
        "Start date is required",
      );
      assertStringIncludes(html, "Start date is required");
    });
  });

  describe("HolidayEditPanel", () => {
    test("renders the edit form with prefilled values", () => {
      const html = String(HolidayEditPanel({ holiday }));
      expectIncludesAll(html, [
        'action="/admin/holidays/42/edit"',
        "Christmas",
        "2026-12-25",
        "Save Changes",
      ]);
    });

    test("renders a submitted error and values", () => {
      const html = String(
        HolidayEditPanel({
          error: "Date error",
          holiday,
          values: {
            end_date: "2027-01-02",
            name: "Winter break",
            start_date: "2027-01-01",
          },
        }),
      );
      expectIncludesAll(html, [
        "Date error",
        "Winter break",
        "2027-01-01",
        "2027-01-02",
      ]);
    });
  });

  describe("holidayPages.deletePage (resource factory delete confirmation)", () => {
    test("renders the type-the-name confirmation form posting to the delete path", () => {
      const html = getHolidayPages().deletePage(holiday, OWNER_SESSION);
      expectIncludesAll(html, [
        'action="/admin/holidays/42/delete"',
        'name="confirm_identifier"',
        // The name to type is shown as the confirm target.
        "Christmas",
        "Delete holiday",
      ]);
      assert(!html.includes('<button class="danger"'));
    });

    test("renders the error flash when an error is passed", () => {
      const html = getHolidayPages().deletePage(
        holiday,
        OWNER_SESSION,
        "Holiday name does not match",
      );
      assertStringIncludes(html, "Holiday name does not match");
    });
  });
});
