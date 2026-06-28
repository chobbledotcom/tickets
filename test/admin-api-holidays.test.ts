import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getAllHolidays, holidaysTable } from "#shared/db/holidays.ts";
import {
  apiRequest,
  assertJson,
  createTestHoliday,
  createTestManagerSession,
  describeWithEnv,
  expectRejectsEmptyName,
  mockRequest,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils";

describeWithEnv("Admin API - Holidays", { db: true }, () => {
  describe("GET /api/admin/holidays", () => {
    test("lists all holidays", async () => {
      await createTestHoliday({ name: "Christmas" });
      await createTestHoliday({ name: "New Year" });

      await assertJson(apiRequest("/api/admin/holidays"), 200, (body) => {
        expect(body.holidays.length).toBe(2);
        expect(body.holidays[0].name).toBe("Christmas");
      });
    });

    test("returns empty array when no holidays", async () => {
      await assertJson(apiRequest("/api/admin/holidays"), 200, (body) => {
        expect(body.holidays).toEqual([]);
      });
    });

    test("returns 401 without auth", async () => {
      const response = await handleRequest(mockRequest("/api/admin/holidays"));
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/holidays/:holidayId", () => {
    test("returns single holiday by ID", async () => {
      const holiday = await createTestHoliday({ name: "Easter" });

      await assertJson(
        apiRequest(`/api/admin/holidays/${holiday.id}`),
        200,
        (body) => {
          expect(body.holiday.name).toBe("Easter");
          expect(body.holiday.id).toBe(holiday.id);
          expect(body.holiday.start_date).toBeDefined();
          expect(body.holiday.end_date).toBeDefined();
        },
      );
    });

    test("returns 404 for non-existent holiday", async () => {
      await assertJson(apiRequest("/api/admin/holidays/99999"), 404, (body) => {
        expect(body.error).toBe("Holiday not found");
      });
    });

    test("works with cookie+CSRF auth", async () => {
      const holiday = await createTestHoliday({ name: "Cookie Holiday" });
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await assertJson(
        handleRequest(
          requestAsSession(`/api/admin/holidays/${holiday.id}`, {
            cookie,
            csrfToken,
          }),
        ),
        200,
        (body) => {
          expect(body.holiday.name).toBe("Cookie Holiday");
        },
      );
    });
  });

  describe("POST /api/admin/holidays", () => {
    test("creates holiday with all fields", async () => {
      await assertJson(
        apiRequest("/api/admin/holidays", {
          body: {
            end_date: "2026-08-31",
            name: "Summer Break",
            start_date: "2026-07-01",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.holiday.name).toBe("Summer Break");
          expect(body.holiday.start_date).toBe("2026-07-01");
          expect(body.holiday.end_date).toBe("2026-08-31");
          expect(body.holiday.id).toBeGreaterThan(0);
        },
      );
    });

    test("returns error when name is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/holidays", {
          body: { end_date: "2026-01-02", start_date: "2026-01-01" },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("name is required");
        },
      );
    });

    test("returns error when start_date is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/holidays", {
          body: { end_date: "2026-01-02", name: "Test" },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("start_date is required");
        },
      );
    });

    test("returns error when end_date is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/holidays", {
          body: { name: "Test", start_date: "2026-01-01" },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("end_date is required");
        },
      );
    });

    test("validates end_date >= start_date", async () => {
      await assertJson(
        apiRequest("/api/admin/holidays", {
          body: {
            end_date: "2026-12-20",
            name: "Bad Range",
            start_date: "2026-12-25",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "End date must be on or after the start date",
          );
        },
      );
    });
  });

  describe("PUT /api/admin/holidays/:holidayId", () => {
    test("updates holiday name", async () => {
      const holiday = await createTestHoliday({ name: "Old Name" });

      await assertJson(
        apiRequest(`/api/admin/holidays/${holiday.id}`, {
          body: { name: "New Name" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.holiday.name).toBe("New Name");
          expect(body.holiday.start_date).toBe(holiday.start_date);
        },
      );
    });

    test("updates dates only", async () => {
      const holiday = await createTestHoliday({
        endDate: "2026-01-02",
        name: "Keep Name",
        startDate: "2026-01-01",
      });

      await assertJson(
        apiRequest(`/api/admin/holidays/${holiday.id}`, {
          body: { end_date: "2026-06-30", start_date: "2026-06-01" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.holiday.name).toBe("Keep Name");
          expect(body.holiday.start_date).toBe("2026-06-01");
          expect(body.holiday.end_date).toBe("2026-06-30");
        },
      );
    });

    test("returns 404 for non-existent holiday", async () => {
      await assertJson(
        apiRequest("/api/admin/holidays/99999", {
          body: { name: "Nope" },
          method: "PUT",
        }),
        404,
        (body) => {
          expect(body.error).toBe("Holiday not found");
        },
      );
    });

    test("rejects empty name", async () => {
      const holiday = await createTestHoliday();
      await expectRejectsEmptyName(`/api/admin/holidays/${holiday.id}`);
    });

    test("validates date range on update", async () => {
      const holiday = await createTestHoliday({
        endDate: "2026-01-10",
        startDate: "2026-01-01",
      });

      await assertJson(
        apiRequest(`/api/admin/holidays/${holiday.id}`, {
          body: { end_date: "2026-12-20", start_date: "2026-12-25" },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "End date must be on or after the start date",
          );
        },
      );
    });
  });

  describe("DELETE /api/admin/holidays/:holidayId", () => {
    test("deletes holiday with correct confirmation", async () => {
      const holiday = await createTestHoliday({ name: "To Delete" });

      await assertJson(
        apiRequest(`/api/admin/holidays/${holiday.id}`, {
          body: { confirm_identifier: "To Delete" },
          method: "DELETE",
        }),
        200,
        (body) => {
          expect(body.status).toBe("ok");
        },
      );

      const all = await getAllHolidays();
      expect(all.find((h) => h.id === holiday.id)).toBeUndefined();
    });

    test("rejects delete with wrong confirmation", async () => {
      const holiday = await createTestHoliday({ name: "Protected" });

      await assertJson(
        apiRequest(`/api/admin/holidays/${holiday.id}`, {
          body: { confirm_identifier: "Wrong Name" },
          method: "DELETE",
        }),
        400,
        (body) => {
          expect(body.error).toContain("does not match");
        },
      );

      // Holiday should still exist
      const row = await holidaysTable.findById(holiday.id);
      expect(row).toBeDefined();
    });

    test("returns 404 for non-existent holiday", async () => {
      await assertJson(
        apiRequest("/api/admin/holidays/99999", {
          body: { confirm_identifier: "anything" },
          method: "DELETE",
        }),
        404,
        (body) => {
          expect(body.error).toBe("Holiday not found");
        },
      );
    });
  });

  // Holiday management is owner-only in the dashboard, so the JSON API must
  // reject managers too (a cookie-authenticated manager would otherwise reach
  // owner-gated operations through the API).
  describe("owner-only authorization", () => {
    const managerSession = async () => ({
      cookie: await createTestManagerSession(),
      csrfToken: await testCsrfToken(),
    });

    test("rejects a manager listing holidays with 403 Forbidden", async () => {
      const res = await handleRequest(
        requestAsSession("/api/admin/holidays", await managerSession()),
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Forbidden");
    });

    test("rejects a manager creating a holiday with 403", async () => {
      const res = await handleRequest(
        requestAsSession("/api/admin/holidays", await managerSession(), {
          body: JSON.stringify({
            end_date: "2025-12-26",
            name: "Blocked",
            start_date: "2025-12-25",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(res.status).toBe(403);
      expect(await getAllHolidays()).toEqual([]);
    });

    test("rejects a manager deleting a holiday with 403", async () => {
      const holiday = await createTestHoliday({ name: "Locked" });
      const res = await handleRequest(
        requestAsSession(
          `/api/admin/holidays/${holiday.id}`,
          await managerSession(),
          { method: "DELETE" },
        ),
      );
      expect(res.status).toBe(403);
      // The manager's delete was blocked, so the holiday still exists.
      expect(await holidaysTable.findById(holiday.id)).toBeDefined();
    });
  });
});
