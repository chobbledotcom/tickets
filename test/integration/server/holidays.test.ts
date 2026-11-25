import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import {
  expectActivityLogShows,
  expectFlash,
  expectHtmlResponse,
  expectIncludesAll,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { extractInputValue, requireJoinCsrfToken } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestHoliday,
  deleteTestHoliday,
  updateTestHoliday,
} from "#test-utils/db-helpers/holidays.ts";
import {
  awaitTestRequest,
  mockAdminLoginRequest,
  mockFormRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

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
            adminLevel: "manager",
            csrfToken: await testCsrfToken(),
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

      // Set password for manager
      const joinPageResponse = await handleRequest(
        mockRequest(`/join/${inviteToken}`),
      );
      expect(joinPageResponse.status).toBe(200);
      const joinHtml = await joinPageResponse.text();
      const joinCsrf = requireJoinCsrfToken(joinHtml);

      const joinResponse = await handleRequest(
        mockFormRequest(`/join/${inviteToken}`, {
          csrfToken: joinCsrf,
          password: "managerpass123",
          passwordConfirm: "managerpass123",
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
      // The name links to the holiday's tabbed entity page.
      await expectHtmlResponse(
        response,
        200,
        "Christmas",
        "2026-12-25",
        "2026-12-26",
        `/admin/holidays/${holiday.id}`,
      );
    });
  });

  describe("GET /admin/holidays/new", () => {
    testRequiresAuth("/admin/holidays/new");

    test("shows create holiday form", async () => {
      const response = await adminGet("/admin/holidays/new");
      await expectHtmlResponse(
        response.clone(),
        200,
        "Add holiday",
        "Holiday name",
        "Start date",
        "End date",
      );
      const html = await response.text();
      for (const field of ["name", "startDate", "endDate"]) {
        expect(extractInputValue(html, field)).toBeNull();
      }
    });
  });

  describe("GET /admin/holidays/:id", () => {
    test("fills the edit form with the stored holiday", async () => {
      const holiday = await createTestHoliday({
        endDate: "2026-01-02",
        name: "Test",
        startDate: "2026-01-01",
      });
      const html = await (
        await adminGet(`/admin/holidays/${holiday.id}`)
      ).text();
      expect(extractInputValue(html, "name")).toBe("Test");
      expect(extractInputValue(html, "startDate")).toBe("2026-01-01");
      expect(extractInputValue(html, "endDate")).toBe("2026-01-02");
    });
  });

  describe("POST /admin/holidays", () => {
    testRequiresAuth("/admin/holidays", {
      body: {
        endDate: "2026-12-25",
        name: "Test",
        startDate: "2026-12-25",
      },
      method: "POST",
    });

    for (const [testName, name, startDate, endDate] of [
      ["creates holiday and redirects", "New Year", "2027-01-01", "2027-01-01"],
      ["creates multi-day holiday", "Easter", "2026-04-03", "2026-04-06"],
    ] as const) {
      test(testName, async () => {
        const holiday = await createTestHoliday({ endDate, name, startDate });
        expect(holiday.name).toBe(name);
        expect(holiday.startDate).toBe(startDate);
        expect(holiday.endDate).toBe(endDate);
      });
    }

    test("rejects missing name", async () => {
      const { response } = await adminFormPost("/admin/holidays", {
        endDate: "2026-12-25",
        name: "",
        startDate: "2026-12-25",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Holiday name is required"),
        false,
      );
    });

    test("rejects missing start_date", async () => {
      const { response } = await adminFormPost("/admin/holidays", {
        endDate: "2026-12-25",
        name: "Test",
        startDate: "",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Start date is required"),
        false,
      );
    });

    test("rejects missing end_date", async () => {
      const { response } = await adminFormPost("/admin/holidays", {
        endDate: "",
        name: "Test",
        startDate: "2026-12-25",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("End date is required"),
        false,
      );
    });

    test("rejects invalid date format", async () => {
      const { response } = await adminFormPost("/admin/holidays", {
        endDate: "2026-12-25",
        name: "Test",
        startDate: "not-a-date",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("valid date"), false);
    });

    test("rejects end_date before start_date", async () => {
      const { response } = await adminFormPost("/admin/holidays", {
        endDate: "2026-12-25",
        name: "Test",
        startDate: "2026-12-26",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("End date must be on or after the start date"),
        false,
      );
    });
  });

  describe("nav link", () => {
    test("holidays link visible to owners", async () => {
      const response = await adminGet("/admin/holidays");
      const body = await response.text();
      expectIncludesAll(body, ["/admin/holidays", "Holidays"]);
    });
  });

  describe("activity logging", () => {
    test("logs holiday creation", async () => {
      await createTestHoliday({ name: "Logged Holiday" });
      await expectActivityLogShows("Logged Holiday", "created");
    });

    test("logs holiday update", async () => {
      const holiday = await createTestHoliday({ name: "Before Update" });
      await updateTestHoliday(holiday.id, { name: "Updated Holiday" });
      await expectActivityLogShows("Updated Holiday", "updated");
    });

    test("logs holiday deletion", async () => {
      const holiday = await createTestHoliday({ name: "Deleted Holiday" });
      await deleteTestHoliday(holiday.id);
      await expectActivityLogShows("Deleted Holiday", "deleted");
    });
  });

  test("updates one field without changing the others", async () => {
    const holiday = await createTestHoliday({ name: "Christmas" });
    const updated = await updateTestHoliday(holiday.id, {
      endDate: "2026-12-27",
    });
    expect(updated.name).toBe("Christmas");
    expect(updated.startDate).toBe(holiday.startDate);
    expect(updated.endDate).toBe("2026-12-27");
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
      const { getActiveHolidays } = await import("#db/holidays.ts");
      const active = await getActiveHolidays();
      expect(active.length).toBe(1);
      expect(active[0]!.name).toBe("Future Holiday");
    });
  });
});
