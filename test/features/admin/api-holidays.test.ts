import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { holidays } from "#db/holidays.ts";
import { records } from "#db/record-table.ts";
import { handleRequest } from "#routes";
import {
  deleteJson,
  expectApiRecord,
  type JsonBody,
  postJson,
  putJson,
  requestAsManager,
} from "#test-utils/api/admin-json.ts";
import {
  assertApiDeleteOk,
  assertJson,
  expectApiError,
  expectRejectsEmptyName,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  apiRequest,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

const HOLIDAYS = "/api/admin/holidays";

/** The holiday that an admin API answer holds. */
const expectHoliday = expectApiRecord("holiday");

/** The path of one holiday in the admin API. */
const holidayPath = (id: number | string): string => `${HOLIDAYS}/${id}`;

/** A stored holiday from 1 to 2 January 2026, named `name`. */
const newYearHoliday = (name: string) =>
  createTestHoliday({ endDate: "2026-01-02", name, startDate: "2026-01-01" });

/** Assert that a change to one stored holiday is refused with `message`. */
const expectUpdateRefused = async (
  changes: JsonBody,
  message: string,
): Promise<void> => {
  const holiday = await newYearHoliday("Refused Update");
  await expectApiError(putJson(holidayPath(holiday.id), changes), 400, message);
};

describeWithEnv("Admin API - Holidays", { db: true }, () => {
  describe("GET /api/admin/holidays", () => {
    test("lists all holidays", async () => {
      await createTestHoliday({ name: "Christmas" });
      await createTestHoliday({ name: "New Year" });

      await assertJson(apiRequest(HOLIDAYS), 200, (body) => {
        expect(body.holidays.length).toBe(2);
        expect(body.holidays[0].name).toBe("Christmas");
      });
    });

    test("returns empty array when no holidays", async () => {
      await assertJson(apiRequest(HOLIDAYS), 200, (body) => {
        expect(body.holidays).toEqual([]);
      });
    });

    test("returns 401 without auth", async () => {
      const response = await handleRequest(mockRequest(HOLIDAYS));
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/holidays/:holidayId", () => {
    test("returns single holiday by ID", async () => {
      const holiday = await createTestHoliday({ name: "Easter" });

      await expectHoliday(apiRequest(holidayPath(holiday.id)), 200, (row) => {
        expect(row).toEqual({
          end_date: "2026-12-25",
          id: holiday.id,
          name: "Easter",
          start_date: "2026-12-25",
        });
      });
    });

    test("returns 404 for non-existent holiday", async () => {
      await expectApiError(
        apiRequest(holidayPath(99999)),
        404,
        "Holiday not found",
      );
    });

    test("works with cookie+CSRF auth", async () => {
      const holiday = await createTestHoliday({ name: "Cookie Holiday" });
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await expectHoliday(
        handleRequest(
          requestAsSession(holidayPath(holiday.id), { cookie, csrfToken }),
        ),
        200,
        (row) => expect(row.name).toBe("Cookie Holiday"),
      );
    });
  });

  describe("POST /api/admin/holidays", () => {
    test("creates holiday with all fields", async () => {
      await expectHoliday(
        postJson(HOLIDAYS, {
          end_date: "2026-08-31",
          name: "Summer Break",
          start_date: "2026-07-01",
        }),
        201,
        (row) => {
          expect(row.name).toBe("Summer Break");
          expect(row.start_date).toBe("2026-07-01");
          expect(row.end_date).toBe("2026-08-31");
          expect(row.id).toBeGreaterThan(0);
        },
      );
    });

    // The shared date parser runs at the JSON boundary: every unusable shape
    // the parser refuses answers the field-named message.
    test("refuses unusable date shapes with the field message", async () => {
      for (const [name, start_date] of [
        ["Unpadded", "2026-7-1"],
        ["Rollover", "2026-02-30"],
        ["Datetime", "2026-07-01T00:00"],
        ["Wording", "soon"],
      ]) {
        await expectApiError(
          postJson(HOLIDAYS, { end_date: "2026-08-31", name, start_date }),
          400,
          "start_date has an invalid value",
        );
      }
    });

    test("trims a padded date and stores the clean value", async () => {
      await expectHoliday(
        postJson(HOLIDAYS, {
          end_date: "2026-08-31",
          name: "Padded Create",
          start_date: "  2026-07-01  ",
        }),
        201,
        (row) => expect(row.start_date).toBe("2026-07-01"),
      );
    });

    test("names the first missing field", async () => {
      for (const [body, message] of [
        [
          { end_date: "2026-01-02", start_date: "2026-01-01" },
          "name is required",
        ],
        [{ end_date: "2026-01-02", name: "Test" }, "start_date is required"],
        [{ name: "Test", start_date: "2026-01-01" }, "end_date is required"],
      ] as const) {
        await expectApiError(postJson(HOLIDAYS, body), 400, message);
      }
    });

    test("validates end_date >= start_date", async () => {
      await expectApiError(
        postJson(HOLIDAYS, {
          end_date: "2026-12-20",
          name: "Bad Range",
          start_date: "2026-12-25",
        }),
        400,
        "End date must be on or after the start date",
      );
    });
  });

  describe("PUT /api/admin/holidays/:holidayId", () => {
    test("updates holiday name", async () => {
      const holiday = await createTestHoliday({ name: "Old Name" });

      await expectHoliday(
        putJson(holidayPath(holiday.id), { name: "New Name" }),
        200,
        (row) => {
          expect(row.name).toBe("New Name");
          expect(row.start_date).toBe(holiday.start_date);
        },
      );
    });

    test("keeps the stored dates when none are supplied", async () => {
      const holiday = await newYearHoliday("Stored Dates");

      await expectHoliday(
        putJson(holidayPath(holiday.id), { name: "Renamed Only" }),
        200,
        (row) => {
          expect(row.name).toBe("Renamed Only");
          expect(row.start_date).toBe("2026-01-01");
          expect(row.end_date).toBe("2026-01-02");
        },
      );
    });

    test("updates dates only", async () => {
      const holiday = await newYearHoliday("Keep Name");

      await expectHoliday(
        putJson(holidayPath(holiday.id), {
          end_date: "2026-06-30",
          start_date: "2026-06-01",
        }),
        200,
        (row) => {
          expect(row.name).toBe("Keep Name");
          expect(row.start_date).toBe("2026-06-01");
          expect(row.end_date).toBe("2026-06-30");
        },
      );
    });

    // The update mapper runs the same shared date readers: a stored fallback
    // applies to an absent field, and a supplied unusable date is refused.
    test("refuses an unusable supplied date on update", async () => {
      await expectUpdateRefused(
        { start_date: "2027-02-30" },
        "start_date has an invalid value",
      );
    });

    test("refuses a non-string date on update", async () => {
      await expectUpdateRefused(
        { start_date: 42 },
        "start_date has an invalid value",
      );
    });

    test("trims a padded date on update", async () => {
      const holiday = await createTestHoliday({
        endDate: "2027-06-30",
        name: "Padded Date",
        startDate: "2026-06-01",
      });

      await expectHoliday(
        putJson(holidayPath(holiday.id), { start_date: "  2027-06-01" }),
        200,
        (row) => expect(row.start_date).toBe("2027-06-01"),
      );
      expect(
        (await holidays.getAll()).find((h) => h.id === holiday.id)?.start_date,
      ).toBe("2027-06-01");
    });

    test("returns 404 for non-existent holiday", async () => {
      await expectApiError(
        putJson(holidayPath(99999), { name: "Nope" }),
        404,
        "Holiday not found",
      );
    });

    test("rejects empty name", async () => {
      const holiday = await createTestHoliday();
      await expectRejectsEmptyName(holidayPath(holiday.id));
    });

    test("validates date range on update", async () => {
      await expectUpdateRefused(
        { end_date: "2026-12-20", start_date: "2026-12-25" },
        "End date must be on or after the start date",
      );
    });
  });

  describe("DELETE /api/admin/holidays/:holidayId", () => {
    test("deletes holiday with correct confirmation", async () => {
      const holiday = await createTestHoliday({ name: "To Delete" });

      await assertApiDeleteOk(holidayPath(holiday.id), "To Delete");

      const all = await holidays.getAll();
      expect(all.map((h) => h.id)).not.toContain(holiday.id);
    });

    test("rejects delete with wrong confirmation", async () => {
      const holiday = await createTestHoliday({ name: "Protected" });

      await assertJson(
        deleteJson(holidayPath(holiday.id), {
          confirm_identifier: "Wrong Name",
        }),
        400,
        (body) => {
          assertStringIncludes(body.error, "does not match");
        },
      );

      // Holiday should still exist
      const row = await records.holidays.find(holiday.id);
      expect(row?.name).toBe("Protected");
    });

    test("returns 404 for non-existent holiday", async () => {
      await expectApiError(
        deleteJson(holidayPath(99999), { confirm_identifier: "anything" }),
        404,
        "Holiday not found",
      );
    });
  });

  // Holiday management is owner-only in the dashboard, so the JSON API must
  // reject managers too (a cookie-authenticated manager would otherwise reach
  // owner-gated operations through the API).
  describe("owner-only authorization", () => {
    test("rejects a manager listing holidays with 403 Forbidden", async () => {
      await expectApiError(requestAsManager(HOLIDAYS), 403, "Forbidden");
    });

    test("rejects a manager creating a holiday with 403", async () => {
      const res = await requestAsManager(HOLIDAYS, {
        body: {
          end_date: "2025-12-26",
          name: "Blocked",
          start_date: "2025-12-25",
        },
        method: "POST",
      });
      expect(res.status).toBe(403);
      expect(await holidays.getAll()).toEqual([]);
    });

    test("rejects a manager deleting a holiday with 403", async () => {
      const holiday = await createTestHoliday({ name: "Locked" });
      const res = await requestAsManager(holidayPath(holiday.id), {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      // The manager's delete was blocked, so the holiday still exists.
      expect((await records.holidays.find(holiday.id))?.name).toBe("Locked");
    });
  });
});
