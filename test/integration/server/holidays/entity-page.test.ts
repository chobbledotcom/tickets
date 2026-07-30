import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { holidays } from "#shared/db/holidays.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestHoliday,
  deleteTestHoliday,
} from "#test-utils/db-helpers/holidays.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("holiday entity page", { db: true }, () => {
  describe("GET /admin/holidays/:id", () => {
    testRequiresAuth("/admin/holidays/1", {
      setup: async () => {
        await createTestHoliday();
      },
    });

    test("shows the edit tab by default", async () => {
      const holiday = await createTestHoliday({
        endDate: "2026-12-26",
        name: "Christmas",
        startDate: "2026-12-25",
      });
      const response = await adminGet(`/admin/holidays/${holiday.id}`);
      const html = await expectHtmlResponse(
        response,
        200,
        "Christmas",
        "Edit",
        "Actions",
        "2026-12-25",
        "2026-12-26",
      );
      expect(html).toContain(
        '<a class="active" href="/admin/holidays">Holidays</a>',
      );
    });

    test("returns 404 for an unknown tab", async () => {
      const holiday = await createTestHoliday();
      const response = await adminGet(`/admin/holidays/${holiday.id}/unknown`);
      expectStatus(404)(response);
    });
  });

  describe("GET /admin/holidays/:id/edit", () => {
    testRequiresAuth("/admin/holidays/1/edit", {
      setup: async () => {
        await createTestHoliday();
      },
    });

    test("shows edit form with pre-filled values", async () => {
      const holiday = await createTestHoliday({
        endDate: "2026-12-26",
        name: "Christmas",
        startDate: "2026-12-25",
      });
      const response = await adminGet(`/admin/holidays/${holiday.id}/edit`);
      const html = await expectHtmlResponse(
        response,
        200,
        "Christmas",
        "2026-12-25",
        "2026-12-26",
      );
      expect(html).not.toContain(`/admin/holidays/${holiday.id}/delete`);
    });

    test("returns 404 for non-existent holiday", async () => {
      const response = await adminGet("/admin/holidays/999/edit");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/holidays/:id/edit", () => {
    testRequiresAuth("/admin/holidays/1/edit", {
      body: {
        end_date: "2026-12-25",
        name: "Updated",
        start_date: "2026-12-25",
      },
      method: "POST",
      setup: async () => {
        await createTestHoliday();
      },
    });

    test("updates holiday", async () => {
      const holiday = await createTestHoliday({ name: "Christmas" });
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/edit`,
        {
          end_date: "2026-12-27",
          name: "Christmas",
          start_date: holiday.start_date,
        },
      );
      await expectFlashRedirect(
        `/admin/holidays/${holiday.id}`,
        "Holiday updated",
      )(response);
      const { holidays } = await import("#shared/db/holidays.ts");
      expect(await holidays.table.findById(holiday.id)).toEqual({
        ...holiday,
        end_date: "2026-12-27",
      });
    });

    test("shows a date-range error with submitted values", async () => {
      const holiday = await createTestHoliday();
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/edit`,
        {
          end_date: "2026-12-25",
          name: "Test",
          start_date: "2026-12-26",
        },
      );
      await expectHtmlResponse(
        response,
        400,
        "End date must be on or after the start date",
        'value="2026-12-26"',
        'value="2026-12-25"',
      );
    });

    test("returns 404 for non-existent holiday", async () => {
      const { response } = await adminFormPost("/admin/holidays/999/edit", {
        end_date: "2026-12-25",
        name: "Test",
        start_date: "2026-12-25",
      });
      expectStatus(404)(response);
    });

    test("shows a field error on edit", async () => {
      const holiday = await createTestHoliday();
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/edit`,
        {
          end_date: "2026-12-25",
          name: "",
          start_date: "2026-12-25",
        },
      );
      await expectHtmlResponse(
        response,
        400,
        "Holiday name is required",
        'value="2026-12-25"',
      );
    });
  });

  describe("GET /admin/holidays/:id/actions", () => {
    test("shows the delete action", async () => {
      const holiday = await createTestHoliday({ name: "Christmas" });
      const response = await adminGet(`/admin/holidays/${holiday.id}/actions`);
      await expectHtmlResponse(
        response,
        200,
        "Christmas",
        "Actions",
        `/admin/holidays/${holiday.id}/delete`,
      );
    });
  });

  describe("GET /admin/holidays/:id/delete", () => {
    testRequiresAuth("/admin/holidays/1/delete", {
      setup: async () => {
        await createTestHoliday();
      },
    });

    test("shows delete confirmation page", async () => {
      const holiday = await createTestHoliday({ name: "Christmas" });
      const response = await adminGet(`/admin/holidays/${holiday.id}/delete`);
      await expectHtmlResponse(
        response,
        200,
        "Delete Holiday",
        "Christmas",
        "confirm_identifier",
      );
    });

    test("returns 404 for non-existent holiday", async () => {
      const response = await adminGet("/admin/holidays/999/delete");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/holidays/:id/delete", () => {
    testRequiresAuth("/admin/holidays/1/delete", {
      body: { confirm_identifier: "Test Holiday" },
      method: "POST",
      setup: async () => {
        await createTestHoliday();
      },
    });

    test("deletes holiday with correct name confirmation", async () => {
      const holiday = await createTestHoliday({ name: "To Delete" });
      await deleteTestHoliday(holiday.id);
      const { holidays } = await import("#shared/db/holidays.ts");
      expect(await holidays.table.findById(holiday.id)).toBeNull();
    });

    test("rejects deletion with wrong name", async () => {
      const holiday = await createTestHoliday({ name: "Christmas" });
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/delete`,
        { confirm_identifier: "Wrong Name" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Holiday name does not match"),
        false,
      );
      const { holidays } = await import("#shared/db/holidays.ts");
      expect(await holidays.table.findById(holiday.id)).not.toBeNull();
    });

    test("name confirmation is case-insensitive", async () => {
      const holiday = await createTestHoliday({ name: "Christmas Day" });
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/delete`,
        { confirm_identifier: "christmas day" },
      );
      await expectFlashRedirect("/admin/holidays", "Holiday deleted")(response);
      expect(await holidays.table.findById(holiday.id)).toBeNull();
    });

    test("returns 404 for non-existent holiday", async () => {
      const { response } = await adminFormPost("/admin/holidays/999/delete", {
        confirm_identifier: "Test",
      });
      expectStatus(404)(response);
    });
  });
});
