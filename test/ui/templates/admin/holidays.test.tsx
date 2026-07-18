import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type { AdminSession, Holiday } from "#shared/types.ts";
import {
  adminHolidaysPage,
  getHolidayPages,
  HolidayEditPanel,
} from "#templates/admin/holidays.tsx";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";

const session: AdminSession = { adminLevel: "owner" };

const holiday: Holiday = {
  end_date: "2026-12-26",
  id: 42,
  name: "Christmas",
  start_date: "2026-12-25",
};

describe("holiday templates", () => {
  beforeAll(async () => {
    setupTestEncryptionKey();
    await signCsrfToken();
  });

  describe("adminHolidaysPage (resource factory list page)", () => {
    test("renders the add-holiday action and guide link in the action row", () => {
      const html = adminHolidaysPage([holiday], session);
      expect(html).toContain('href="/admin/holidays/new"');
      expect(html).toContain("Add Holiday");
      expect(html).toContain('href="/admin/guide#holidays"');
    });

    test("renders the table with name links and start/end columns", () => {
      const html = adminHolidaysPage([holiday], session);
      expect(html).toContain(
        '<a class="active" href="/admin/holidays">Holidays</a>',
      );
      expect(html).toContain('href="/admin/holidays/42"');
      expect(html).toContain("Christmas");
      expect(html).toContain("2026-12-25");
      expect(html).toContain("2026-12-26");
    });

    test("renders the empty state when there are no holidays", () => {
      const html = adminHolidaysPage([], session);
      // The empty-state paragraph; assert no edit links (the only /admin/holidays
      // links are the nav link and the add action).
      expect(html).toContain("No holidays configured");
      expect(html).not.toContain('href="/admin/holidays/42"');
    });

    test("renders the success flash when a success message is passed", () => {
      const html = adminHolidaysPage([], session, "Holiday deleted");
      expect(html).toContain("Holiday deleted");
    });

    test("shows holiday data without write links in read-only mode", () => {
      using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
      const html = adminHolidaysPage([holiday], session);
      expect(html).toContain("Christmas");
      expect(html).not.toContain('href="/admin/holidays/new"');
      expect(html).not.toContain('href="/admin/holidays/42"');
    });
  });

  describe("holidayPages.newPage (resource factory new page)", () => {
    test("renders the create form posting to the base path with the add fields", () => {
      const html = getHolidayPages().newPage(session);
      expect(html).toContain('action="/admin/holidays"');
      expect(html).toContain('name="name"');
      expect(html).toContain('name="start_date"');
      expect(html).toContain('name="end_date"');
      // Submit button uses the create label and plus icon.
      expect(html).toContain("Create Holiday");
    });

    test("renders the error flash when an error is passed", () => {
      const html = getHolidayPages().newPage(session, "Start Date is required");
      expect(html).toContain("Start Date is required");
    });
  });

  describe("HolidayEditPanel", () => {
    test("renders the edit form with prefilled values", () => {
      const html = String(HolidayEditPanel({ holiday }));
      expect(html).toContain('action="/admin/holidays/42/edit"');
      expect(html).toContain("Christmas");
      expect(html).toContain("2026-12-25");
      expect(html).toContain("Save Changes");
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
      expect(html).toContain("Date error");
      expect(html).toContain("Winter break");
      expect(html).toContain("2027-01-01");
      expect(html).toContain("2027-01-02");
    });
  });

  describe("holidayPages.deletePage (resource factory delete confirmation)", () => {
    test("renders the type-the-name confirmation form posting to the delete path", () => {
      const html = getHolidayPages().deletePage(holiday, session);
      expect(html).toContain('action="/admin/holidays/42/delete"');
      expect(html).toContain('name="confirm_identifier"');
      // The name to type is shown as the confirm target.
      expect(html).toContain("Christmas");
      expect(html).toContain("Delete Holiday");
      expect(html).not.toContain('<button class="danger"');
    });

    test("renders the error flash when an error is passed", () => {
      const html = getHolidayPages().deletePage(
        holiday,
        session,
        "Holiday name does not match",
      );
      expect(html).toContain("Holiday name does not match");
    });
  });
});
