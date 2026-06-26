import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestHoliday,
  deleteTestHoliday,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
  requireJoinCsrfToken,
  testCookie,
  testCsrfToken,
  testHoliday,
  testRequiresAuth,
  updateTestHoliday,
} from "#test-utils";

describeWithEnv("server (admin holidays)", { db: true }, () => {
  describe("GET /admin/holidays", () => {
    testRequiresAuth("/admin/holidays");

    test("returns 403 for non-owner", async () => {
      // Create a manager user and login
      // Create a manager invite
      const inviteResponse = await handleRequest(
        mockFormRequest(
          "/admin/users",
          {
            admin_level: "manager",
            csrf_token: await testCsrfToken(),
            username: "manager1",
          },
          await testCookie(),
        ),
      );
      expect(inviteResponse.status).toBe(302);
      const inviteUrl = inviteResponse.headers.get("location") ?? "";
      const inviteMatch = inviteUrl.match(/invite=([^&]+)/);
      expect(inviteMatch).not.toBeNull();
      const inviteLink = decodeURIComponent(inviteMatch?.[1] as string);
      // Extract token from invite link
      const inviteToken = inviteLink.split("/join/")[1];
      expect(inviteToken).toBeTruthy();

      // Set password for manager
      const joinPageResponse = await handleRequest(
        mockRequest(`/join/${inviteToken}`),
      );
      expect(joinPageResponse.status).toBe(200);
      const joinHtml = await joinPageResponse.text();
      const joinCsrf = requireJoinCsrfToken(joinHtml);

      const joinResponse = await handleRequest(
        mockFormRequest(`/join/${inviteToken}`, {
          csrf_token: joinCsrf,
          password: "managerpass123",
          password_confirm: "managerpass123",
        }),
      );
      expect(joinResponse.status).toBe(302);

      // Joining self-activates the manager — no separate admin activation step.

      // Login as manager
      const loginResponse = await handleRequest(
        await mockAdminLoginRequest({
          password: "managerpass123",
          username: "manager1",
        }),
      );
      const managerCookie =
        loginResponse.headers
          .getSetCookie()
          .find((c) => c.startsWith(`${getSessionCookieName()}=`)) ?? "";

      // Manager tries to access holidays
      const response = await awaitTestRequest("/admin/holidays", {
        cookie: managerCookie,
      });
      expect(response.status).toBe(403);
    });

    test("shows empty holidays list", async () => {
      const response = await adminGet("/admin/holidays");
      await expectHtmlResponse(
        response,
        200,
        "Holidays",
        "No holidays configured",
      );
    });

    test("shows holidays in table when present", async () => {
      const holiday = await createTestHoliday({
        endDate: "2026-12-26",
        name: "Christmas",
        startDate: "2026-12-25",
      });
      const response = await adminGet("/admin/holidays");
      // The name links to the edit page; delete now lives on that edit page,
      // not inline in the list table.
      await expectHtmlResponse(
        response,
        200,
        "Christmas",
        "2026-12-25",
        "2026-12-26",
        `/admin/holidays/${holiday.id}/edit`,
      );
    });
  });

  describe("GET /admin/holidays/new", () => {
    testRequiresAuth("/admin/holidays/new");

    test("shows create holiday form", async () => {
      const response = await adminGet("/admin/holidays/new");
      await expectHtmlResponse(
        response,
        200,
        "Add Holiday",
        "Holiday Name",
        "Start Date",
        "End Date",
      );
    });
  });

  describe("POST /admin/holidays", () => {
    testRequiresAuth("/admin/holidays", {
      body: {
        end_date: "2026-12-25",
        name: "Test",
        start_date: "2026-12-25",
      },
      method: "POST",
    });

    test("creates holiday and redirects", async () => {
      const holiday = await createTestHoliday({
        endDate: "2027-01-01",
        name: "New Year",
        startDate: "2027-01-01",
      });
      expect(holiday.name).toBe("New Year");
      expect(holiday.start_date).toBe("2027-01-01");
      expect(holiday.end_date).toBe("2027-01-01");
    });

    test("creates multi-day holiday", async () => {
      const holiday = await createTestHoliday({
        endDate: "2026-04-06",
        name: "Easter",
        startDate: "2026-04-03",
      });
      expect(holiday.name).toBe("Easter");
      expect(holiday.start_date).toBe("2026-04-03");
      expect(holiday.end_date).toBe("2026-04-06");
    });

    test("rejects missing name", async () => {
      const { response } = await adminFormPost("/admin/holidays", {
        end_date: "2026-12-25",
        name: "",
        start_date: "2026-12-25",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Holiday Name is required"),
        false,
      );
    });

    test("rejects missing start_date", async () => {
      const { response } = await adminFormPost("/admin/holidays", {
        end_date: "2026-12-25",
        name: "Test",
        start_date: "",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Start Date is required"),
        false,
      );
    });

    test("rejects missing end_date", async () => {
      const { response } = await adminFormPost("/admin/holidays", {
        end_date: "",
        name: "Test",
        start_date: "2026-12-25",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("End Date is required"),
        false,
      );
    });

    test("rejects invalid date format", async () => {
      const { response } = await adminFormPost("/admin/holidays", {
        end_date: "2026-12-25",
        name: "Test",
        start_date: "not-a-date",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("valid date"), false);
    });

    test("rejects end_date before start_date", async () => {
      const { response } = await adminFormPost("/admin/holidays", {
        end_date: "2026-12-25",
        name: "Test",
        start_date: "2026-12-26",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("End date must be on or after the start date"),
        false,
      );
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
      await expectHtmlResponse(
        response,
        200,
        "Edit Holiday",
        "Christmas",
        "2026-12-25",
        "2026-12-26",
        // Delete moved off the list table onto the edit page.
        `/admin/holidays/${holiday.id}/delete`,
      );
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
      const updated = await updateTestHoliday(holiday.id, {
        endDate: "2026-12-27",
      });
      expect(updated.name).toBe("Christmas");
      expect(updated.end_date).toBe("2026-12-27");
    });

    test("rejects end_date before start_date on edit", async () => {
      const holiday = await createTestHoliday();
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/edit`,
        {
          end_date: "2026-12-25",
          name: "Test",
          start_date: "2026-12-26",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("End date must be on or after the start date"),
        false,
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

    test("rejects invalid form data on edit", async () => {
      const holiday = await createTestHoliday();
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/edit`,
        {
          end_date: "2026-12-25",
          name: "",
          start_date: "2026-12-25",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Holiday Name is required"),
        false,
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
      body: {
        confirm_identifier: "Test Holiday",
      },
      method: "POST",
      setup: async () => {
        await createTestHoliday();
      },
    });

    test("deletes holiday with correct name confirmation", async () => {
      const holiday = await createTestHoliday({ name: "To Delete" });
      await deleteTestHoliday(holiday.id);

      // Verify it's gone
      const { holidaysTable } = await import("#shared/db/holidays.ts");
      const found = await holidaysTable.findById(holiday.id);
      expect(found).toBeNull();
    });

    test("rejects deletion with wrong name", async () => {
      const holiday = await createTestHoliday({ name: "Christmas" });
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/delete`,
        {
          confirm_identifier: "Wrong Name",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Holiday name does not match"),
        false,
      );

      // Verify holiday still exists
      const { holidaysTable } = await import("#shared/db/holidays.ts");
      const found = await holidaysTable.findById(holiday.id);
      expect(found).not.toBeNull();
    });

    test("name confirmation is case-insensitive", async () => {
      const holiday = await createTestHoliday({ name: "Christmas Day" });
      const { response } = await adminFormPost(
        `/admin/holidays/${holiday.id}/delete`,
        {
          confirm_identifier: "christmas day",
        },
      );
      await expectFlashRedirect("/admin/holidays", "Holiday deleted")(response);
    });

    test("returns 404 for non-existent holiday", async () => {
      const { response } = await adminFormPost("/admin/holidays/999/delete", {
        confirm_identifier: "Test",
      });
      expectStatus(404)(response);
    });
  });

  describe("nav link", () => {
    test("holidays link visible to owners", async () => {
      const response = await adminGet("/admin/holidays");
      const body = await response.text();
      expect(body).toContain("/admin/holidays");
      expect(body).toContain("Holidays");
    });
  });

  describe("activity logging", () => {
    test("logs holiday creation", async () => {
      await createTestHoliday({ name: "Logged Holiday" });
      const response = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Logged Holiday");
      expect(body).toContain("created");
    });

    test("logs holiday update", async () => {
      const holiday = await createTestHoliday({ name: "Before Update" });
      await updateTestHoliday(holiday.id, { name: "After Update" });
      const response = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("After Update");
      expect(body).toContain("updated");
    });

    test("logs holiday deletion", async () => {
      const holiday = await createTestHoliday({ name: "Deleted Holiday" });
      await deleteTestHoliday(holiday.id);
      const response = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Deleted Holiday");
      expect(body).toContain("deleted");
    });
  });

  describe("getActiveHolidays", () => {
    test("returns holidays with end_date >= today", async () => {
      // Create a future holiday
      await createTestHoliday({
        endDate: "2099-01-01",
        name: "Future Holiday",
        startDate: "2099-01-01",
      });
      // Create a past holiday
      await createTestHoliday({
        endDate: "2020-01-01",
        name: "Past Holiday",
        startDate: "2020-01-01",
      });
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const active = await getActiveHolidays();
      expect(active.length).toBe(1);
      expect(active[0]!.name).toBe("Future Holiday");
    });
  });

  describe("holidayToFieldValues", () => {
    test("returns empty defaults when no holiday provided", async () => {
      const { holidayToFieldValues } = await import(
        "#templates/admin/holidays.tsx"
      );
      const values = holidayToFieldValues();
      expect(values.name).toBe("");
      expect(values.start_date).toBe("");
      expect(values.end_date).toBe("");
    });

    test("returns holiday values when holiday provided", async () => {
      const { holidayToFieldValues } = await import(
        "#templates/admin/holidays.tsx"
      );
      const holiday = testHoliday({
        end_date: "2026-01-02",
        name: "Test",
        start_date: "2026-01-01",
      });
      const values = holidayToFieldValues(holiday);
      expect(values.name).toBe("Test");
      expect(values.start_date).toBe("2026-01-01");
      expect(values.end_date).toBe("2026-01-02");
    });
  });

  describe("holidayErrorPage fallback", () => {
    test("returns 404 when holiday not found during edit error", async () => {
      const { response } = await adminFormPost("/admin/holidays/999/edit", {
        end_date: "2026-12-25",
        name: "",
        start_date: "2026-12-25",
      });
      expectStatus(404)(response);
    });

    test("returns 404 when holiday not found during delete error", async () => {
      const { response } = await adminFormPost("/admin/holidays/999/delete", {
        confirm_identifier: "Wrong",
      });
      expectStatus(404)(response);
    });
  });
});
