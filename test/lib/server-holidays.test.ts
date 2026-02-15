import { afterEach, beforeEach, describe, expect, test } from "#test-compat";

import { handleRequest } from "#routes";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestDbWithSetup,
  createTestHoliday,
  deleteTestHoliday,
  loginAsAdmin,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  testHoliday,
  updateTestHoliday,
  expectAdminRedirect,
  expectStatus,
} from "#test-utils";

describe("server (admin holidays)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/holidays", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/holidays"));
      expectAdminRedirect(response);
    });

    test("returns 403 for non-owner", async () => {
      // Create a manager user and login
      const { cookie: ownerCookie, csrfToken: ownerCsrf } = await loginAsAdmin();
      // Create a manager invite
      const inviteResponse = await handleRequest(
        mockFormRequest("/admin/users", {
          username: "manager1",
          admin_level: "manager",
          csrf_token: ownerCsrf,
        }, ownerCookie),
      );
      expect(inviteResponse.status).toBe(302);
      const inviteUrl = inviteResponse.headers.get("location") ?? "";
      const inviteMatch = inviteUrl.match(/invite=([^&]+)/);
      expect(inviteMatch).not.toBeNull();
      const inviteLink = decodeURIComponent(inviteMatch![1] as string);
      // Extract token from invite link
      const inviteToken = inviteLink.split("/join/")[1];
      expect(inviteToken).toBeTruthy();

      // Set password for manager
      const joinPageResponse = await handleRequest(mockRequest(`/join/${inviteToken}`));
      expect(joinPageResponse.status).toBe(200);
      const joinCookie = joinPageResponse.headers.get("set-cookie") ?? "";
      const joinCsrfMatch = joinCookie.match(/join_csrf=([^;]+)/);
      expect(joinCsrfMatch).not.toBeNull();
      const joinCsrf = joinCsrfMatch![1] as string;

      const joinResponse = await handleRequest(
        mockFormRequest(`/join/${inviteToken}`, {
          password: "managerpass123",
          password_confirm: "managerpass123",
          csrf_token: joinCsrf,
        }, `join_csrf=${joinCsrf}`),
      );
      expect(joinResponse.status).toBe(302);

      // Owner activates the manager
      const activateResponse = await handleRequest(
        mockFormRequest("/admin/users/2/activate", {
          csrf_token: ownerCsrf,
        }, ownerCookie),
      );
      expect(activateResponse.status).toBe(302);

      // Login as manager
      const loginResponse = await handleRequest(
        mockAdminLoginRequest({
          username: "manager1",
          password: "managerpass123",
        }),
      );
      const managerCookie = loginResponse.headers.get("set-cookie") ?? "";

      // Manager tries to access holidays
      const response = await awaitTestRequest("/admin/holidays", { cookie: managerCookie });
      expect(response.status).toBe(403);
    });

    test("shows empty holidays list", async () => {
      const { response } = await adminGet("/admin/holidays");
      expectStatus(200)(response);
      const body = await response.text();
      expect(body).toContain("Holidays");
      expect(body).toContain("No holidays configured");
    });

    test("shows holidays in table when present", async () => {
      const holiday = await createTestHoliday({ name: "Christmas", startDate: "2026-12-25", endDate: "2026-12-26" });
      const { response } = await adminGet("/admin/holidays");
      expectStatus(200)(response);
      const body = await response.text();
      expect(body).toContain("Christmas");
      expect(body).toContain("2026-12-25");
      expect(body).toContain("2026-12-26");
      expect(body).toContain(`/admin/holiday/${holiday.id}/edit`);
      expect(body).toContain(`/admin/holiday/${holiday.id}/delete`);
    });
  });

  describe("GET /admin/holiday/new", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/holiday/new"));
      expectAdminRedirect(response);
    });

    test("shows create holiday form", async () => {
      const { response } = await adminGet("/admin/holiday/new");
      expectStatus(200)(response);
      const body = await response.text();
      expect(body).toContain("Add Holiday");
      expect(body).toContain("Holiday Name");
      expect(body).toContain("Start Date");
      expect(body).toContain("End Date");
    });
  });

  describe("POST /admin/holiday", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/holiday", {
          name: "Test",
          start_date: "2026-12-25",
          end_date: "2026-12-25",
        }),
      );
      expectAdminRedirect(response);
    });

    test("creates holiday and redirects", async () => {
      const holiday = await createTestHoliday({
        name: "New Year",
        startDate: "2027-01-01",
        endDate: "2027-01-01",
      });
      expect(holiday.name).toBe("New Year");
      expect(holiday.start_date).toBe("2027-01-01");
      expect(holiday.end_date).toBe("2027-01-01");
    });

    test("creates multi-day holiday", async () => {
      const holiday = await createTestHoliday({
        name: "Easter",
        startDate: "2026-04-03",
        endDate: "2026-04-06",
      });
      expect(holiday.name).toBe("Easter");
      expect(holiday.start_date).toBe("2026-04-03");
      expect(holiday.end_date).toBe("2026-04-06");
    });

    test("rejects missing name", async () => {
      const { response } = await adminFormPost("/admin/holiday", {
        name: "",
        start_date: "2026-12-25",
        end_date: "2026-12-25",
      });
      expectStatus(400)(response);
      const body = await response.text();
      expect(body).toContain("Holiday Name is required");
    });

    test("rejects missing start_date", async () => {
      const { response } = await adminFormPost("/admin/holiday", {
        name: "Test",
        start_date: "",
        end_date: "2026-12-25",
      });
      expectStatus(400)(response);
      const body = await response.text();
      expect(body).toContain("Start Date is required");
    });

    test("rejects missing end_date", async () => {
      const { response } = await adminFormPost("/admin/holiday", {
        name: "Test",
        start_date: "2026-12-25",
        end_date: "",
      });
      expectStatus(400)(response);
      const body = await response.text();
      expect(body).toContain("End Date is required");
    });

    test("rejects invalid date format", async () => {
      const { response } = await adminFormPost("/admin/holiday", {
        name: "Test",
        start_date: "not-a-date",
        end_date: "2026-12-25",
      });
      expectStatus(400)(response);
      const body = await response.text();
      expect(body).toContain("valid date");
    });

    test("rejects end_date before start_date", async () => {
      const { response } = await adminFormPost("/admin/holiday", {
        name: "Test",
        start_date: "2026-12-26",
        end_date: "2026-12-25",
      });
      expectStatus(400)(response);
      const body = await response.text();
      expect(body).toContain("End date must be on or after the start date");
    });
  });

  describe("GET /admin/holiday/:id/edit", () => {
    test("redirects to login when not authenticated", async () => {
      const holiday = await createTestHoliday();
      const response = await handleRequest(mockRequest(`/admin/holiday/${holiday.id}/edit`));
      expectAdminRedirect(response);
    });

    test("shows edit form with pre-filled values", async () => {
      const holiday = await createTestHoliday({ name: "Christmas", startDate: "2026-12-25", endDate: "2026-12-26" });
      const { response } = await adminGet(`/admin/holiday/${holiday.id}/edit`);
      expectStatus(200)(response);
      const body = await response.text();
      expect(body).toContain("Edit Holiday");
      expect(body).toContain("Christmas");
      expect(body).toContain("2026-12-25");
      expect(body).toContain("2026-12-26");
    });

    test("returns 404 for non-existent holiday", async () => {
      const { response } = await adminGet("/admin/holiday/999/edit");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/holiday/:id/edit", () => {
    test("redirects to login when not authenticated", async () => {
      const holiday = await createTestHoliday();
      const response = await handleRequest(
        mockFormRequest(`/admin/holiday/${holiday.id}/edit`, {
          name: "Updated",
          start_date: "2026-12-25",
          end_date: "2026-12-25",
        }),
      );
      expectAdminRedirect(response);
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
      const { response } = await adminFormPost(`/admin/holiday/${holiday.id}/edit`, {
        name: "Test",
        start_date: "2026-12-26",
        end_date: "2026-12-25",
      });
      expectStatus(400)(response);
      const body = await response.text();
      expect(body).toContain("End date must be on or after the start date");
    });

    test("returns 404 for non-existent holiday", async () => {
      const { response } = await adminFormPost("/admin/holiday/999/edit", {
        name: "Test",
        start_date: "2026-12-25",
        end_date: "2026-12-25",
      });
      expectStatus(404)(response);
    });

    test("rejects invalid form data on edit", async () => {
      const holiday = await createTestHoliday();
      const { response } = await adminFormPost(`/admin/holiday/${holiday.id}/edit`, {
        name: "",
        start_date: "2026-12-25",
        end_date: "2026-12-25",
      });
      expectStatus(400)(response);
      const body = await response.text();
      expect(body).toContain("Holiday Name is required");
    });
  });

  describe("GET /admin/holiday/:id/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const holiday = await createTestHoliday();
      const response = await handleRequest(mockRequest(`/admin/holiday/${holiday.id}/delete`));
      expectAdminRedirect(response);
    });

    test("shows delete confirmation page", async () => {
      const holiday = await createTestHoliday({ name: "Christmas" });
      const { response } = await adminGet(`/admin/holiday/${holiday.id}/delete`);
      expectStatus(200)(response);
      const body = await response.text();
      expect(body).toContain("Delete Holiday");
      expect(body).toContain("Christmas");
      expect(body).toContain("confirm_identifier");
    });

    test("returns 404 for non-existent holiday", async () => {
      const { response } = await adminGet("/admin/holiday/999/delete");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/holiday/:id/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const holiday = await createTestHoliday();
      const response = await handleRequest(
        mockFormRequest(`/admin/holiday/${holiday.id}/delete`, {
          confirm_identifier: "Test Holiday",
        }),
      );
      expectAdminRedirect(response);
    });

    test("deletes holiday with correct name confirmation", async () => {
      const holiday = await createTestHoliday({ name: "To Delete" });
      await deleteTestHoliday(holiday.id);

      // Verify it's gone
      const { holidaysTable } = await import("#lib/db/holidays.ts");
      const found = await holidaysTable.findById(holiday.id);
      expect(found).toBeNull();
    });

    test("rejects deletion with wrong name", async () => {
      const holiday = await createTestHoliday({ name: "Christmas" });
      const { response } = await adminFormPost(`/admin/holiday/${holiday.id}/delete`, {
        confirm_identifier: "Wrong Name",
      });
      expectStatus(400)(response);
      const body = await response.text();
      expect(body).toContain("Holiday name does not match");

      // Verify holiday still exists
      const { holidaysTable } = await import("#lib/db/holidays.ts");
      const found = await holidaysTable.findById(holiday.id);
      expect(found).not.toBeNull();
    });

    test("name confirmation is case-insensitive", async () => {
      const holiday = await createTestHoliday({ name: "Christmas Day" });
      const { response } = await adminFormPost(`/admin/holiday/${holiday.id}/delete`, {
        confirm_identifier: "christmas day",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/holidays");
    });

    test("returns 404 for non-existent holiday", async () => {
      const { response } = await adminFormPost("/admin/holiday/999/delete", {
        confirm_identifier: "Test",
      });
      expectStatus(404)(response);
    });
  });

  describe("nav link", () => {
    test("holidays link visible to owners", async () => {
      const { response } = await adminGet("/admin/holidays");
      const body = await response.text();
      expect(body).toContain("/admin/holidays");
      expect(body).toContain("Holidays");
    });
  });

  describe("activity logging", () => {
    test("logs holiday creation", async () => {
      await createTestHoliday({ name: "Logged Holiday" });
      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Logged Holiday");
      expect(body).toContain("created");
    });

    test("logs holiday update", async () => {
      const holiday = await createTestHoliday({ name: "Before Update" });
      await updateTestHoliday(holiday.id, { name: "After Update" });
      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("After Update");
      expect(body).toContain("updated");
    });

    test("logs holiday deletion", async () => {
      const holiday = await createTestHoliday({ name: "Deleted Holiday" });
      await deleteTestHoliday(holiday.id);
      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Deleted Holiday");
      expect(body).toContain("deleted");
    });
  });

  describe("getActiveHolidays", () => {
    test("returns holidays with end_date >= today", async () => {
      // Create a future holiday
      await createTestHoliday({ name: "Future Holiday", startDate: "2099-01-01", endDate: "2099-01-01" });
      // Create a past holiday
      await createTestHoliday({ name: "Past Holiday", startDate: "2020-01-01", endDate: "2020-01-01" });
      const { getActiveHolidays } = await import("#lib/db/holidays.ts");
      const active = await getActiveHolidays("UTC");
      expect(active.length).toBe(1);
      expect(active[0]!.name).toBe("Future Holiday");
    });
  });

  describe("holidayToFieldValues", () => {
    test("returns empty defaults when no holiday provided", async () => {
      const { holidayToFieldValues } = await import("#templates/admin/holidays.tsx");
      const values = holidayToFieldValues();
      expect(values.name).toBe("");
      expect(values.start_date).toBe("");
      expect(values.end_date).toBe("");
    });

    test("returns holiday values when holiday provided", async () => {
      const { holidayToFieldValues } = await import("#templates/admin/holidays.tsx");
      const holiday = testHoliday({ name: "Test", start_date: "2026-01-01", end_date: "2026-01-02" });
      const values = holidayToFieldValues(holiday);
      expect(values.name).toBe("Test");
      expect(values.start_date).toBe("2026-01-01");
      expect(values.end_date).toBe("2026-01-02");
    });
  });

  describe("holidayErrorPage fallback", () => {
    test("returns 404 when holiday not found during edit error", async () => {
      const { response } = await adminFormPost("/admin/holiday/999/edit", {
        name: "",
        start_date: "2026-12-25",
        end_date: "2026-12-25",
      });
      expectStatus(404)(response);
    });

    test("returns 404 when holiday not found during delete error", async () => {
      const { response } = await adminFormPost("/admin/holiday/999/delete", {
        confirm_identifier: "Wrong",
      });
      expectStatus(404)(response);
    });
  });
});
