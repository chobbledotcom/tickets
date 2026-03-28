import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllHolidays, holidaysTable } from "#lib/db/holidays.ts";
import { handleRequest } from "#routes";
import {
  apiRequest,
  assertJson,
  createTestHoliday,
  describeWithEnv,
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
        expect(body.message).toBe("Holiday not found");
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
          method: "POST",
          body: {
            name: "Summer Break",
            start_date: "2026-07-01",
            end_date: "2026-08-31",
          },
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
          method: "POST",
          body: { start_date: "2026-01-01", end_date: "2026-01-02" },
        }),
        400,
        (body) => {
          expect(body.message).toBe("name is required");
        },
      );
    });

    test("returns error when start_date is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/holidays", {
          method: "POST",
          body: { name: "Test", end_date: "2026-01-02" },
        }),
        400,
        (body) => {
          expect(body.message).toBe("start_date is required");
        },
      );
    });

    test("returns error when end_date is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/holidays", {
          method: "POST",
          body: { name: "Test", start_date: "2026-01-01" },
        }),
        400,
        (body) => {
          expect(body.message).toBe("end_date is required");
        },
      );
    });

    test("validates end_date >= start_date", async () => {
      await assertJson(
        apiRequest("/api/admin/holidays", {
          method: "POST",
          body: {
            name: "Bad Range",
            start_date: "2026-12-25",
            end_date: "2026-12-20",
          },
        }),
        400,
        (body) => {
          expect(body.message).toBe(
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
          method: "PUT",
          body: { name: "New Name" },
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
        name: "Keep Name",
        startDate: "2026-01-01",
        endDate: "2026-01-02",
      });

      await assertJson(
        apiRequest(`/api/admin/holidays/${holiday.id}`, {
          method: "PUT",
          body: { start_date: "2026-06-01", end_date: "2026-06-30" },
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
          method: "PUT",
          body: { name: "Nope" },
        }),
        404,
        (body) => {
          expect(body.message).toBe("Holiday not found");
        },
      );
    });

    test("rejects empty name", async () => {
      const holiday = await createTestHoliday();

      await assertJson(
        apiRequest(`/api/admin/holidays/${holiday.id}`, {
          method: "PUT",
          body: { name: "" },
        }),
        400,
        (body) => {
          expect(body.message).toBe("name cannot be empty");
        },
      );
    });

    test("validates date range on update", async () => {
      const holiday = await createTestHoliday({
        startDate: "2026-01-01",
        endDate: "2026-01-10",
      });

      await assertJson(
        apiRequest(`/api/admin/holidays/${holiday.id}`, {
          method: "PUT",
          body: { start_date: "2026-12-25", end_date: "2026-12-20" },
        }),
        400,
        (body) => {
          expect(body.message).toBe(
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
          method: "DELETE",
          body: { confirm_identifier: "To Delete" },
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
          method: "DELETE",
          body: { confirm_identifier: "Wrong Name" },
        }),
        400,
        (body) => {
          expect(body.message).toContain("does not match");
        },
      );

      // Holiday should still exist
      const row = await holidaysTable.findById(holiday.id);
      expect(row).toBeDefined();
    });

    test("returns 404 for non-existent holiday", async () => {
      await assertJson(
        apiRequest("/api/admin/holidays/99999", {
          method: "DELETE",
          body: { confirm_identifier: "anything" },
        }),
        404,
        (body) => {
          expect(body.message).toBe("Holiday not found");
        },
      );
    });
  });
});
