import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { records } from "#db/record-table.ts";
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
      assertStringIncludes(
        html,
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
      assert(!html.includes(`/admin/holidays/${holiday.id}/delete`));
    });

    test("returns 404 for non-existent holiday", async () => {
      const response = await adminGet("/admin/holidays/999/edit");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/holidays/:id/edit", () => {
    testRequiresAuth("/admin/holidays/1/edit", {
      body: {
        endDate: "2026-12-25",
        name: "Updated",
        startDate: "2026-12-25",
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
          endDate: "2026-12-27",
          name: "Christmas",
          startDate: holiday.startDate,
        },
      );
      await expectFlashRedirect(
        `/admin/holidays/${holiday.id}`,
        "Holiday updated",
      )(response);
      expect(await records.holidays.find(holiday.id)).toEqual({
        ...holiday,
        endDate: "2026-12-27",
      });
    });

    test("shows a date-range error with submitted values", async () => {
      const holiday = await createTestHoliday();
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/edit`,
        {
          endDate: "2026-12-25",
          name: "Test",
          startDate: "2026-12-26",
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
        endDate: "2026-12-25",
        name: "Test",
        startDate: "2026-12-25",
      });
      expectStatus(404)(response);
    });

    test("shows a field error on edit", async () => {
      const holiday = await createTestHoliday();
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/edit`,
        {
          endDate: "2026-12-25",
          name: "",
          startDate: "2026-12-25",
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
        "Delete holiday",
        "Christmas",
        "confirmIdentifier",
      );
    });

    test("returns 404 for non-existent holiday", async () => {
      const response = await adminGet("/admin/holidays/999/delete");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/holidays/:id/delete", () => {
    testRequiresAuth("/admin/holidays/1/delete", {
      body: { confirmIdentifier: "Test Holiday" },
      method: "POST",
      setup: async () => {
        await createTestHoliday();
      },
    });

    test("deletes holiday with correct name confirmation", async () => {
      const holiday = await createTestHoliday({ name: "To Delete" });
      await deleteTestHoliday(holiday.id);
      expect(await records.holidays.find(holiday.id)).toBeNull();
    });

    test("rejects deletion with wrong name", async () => {
      const holiday = await createTestHoliday({ name: "Christmas" });
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/delete`,
        { confirmIdentifier: "Wrong Name" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Holiday name does not match"),
        false,
      );
      expect(await records.holidays.find(holiday.id)).not.toBeNull();
    });

    test("name confirmation is case-insensitive", async () => {
      const holiday = await createTestHoliday({ name: "Christmas Day" });
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/delete`,
        { confirmIdentifier: "christmas day" },
      );
      await expectFlashRedirect("/admin/holidays", "Holiday deleted")(response);
      expect(await records.holidays.find(holiday.id)).toBeNull();
    });

    test("returns 404 for non-existent holiday", async () => {
      const { response } = await adminFormPost("/admin/holidays/999/delete", {
        confirmIdentifier: "Test",
      });
      expectStatus(404)(response);
    });
  });
});
