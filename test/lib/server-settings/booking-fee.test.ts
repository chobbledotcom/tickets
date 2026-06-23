import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  getAllActivityLog,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/settings/booking-fee", () => {
    testRequiresAuth("/admin/settings/booking-fee", {
      body: {
        booking_fee: "1.5",
      },
      method: "POST",
    });

    test("saves valid booking fee", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            booking_fee: "1.5",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(response, "Booking fee set to 1.5%");

      expect(settings.bookingFee).toBe("1.5");
    });

    test("saves zero booking fee", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            booking_fee: "0",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(response, "Booking fee set to 0%");
    });

    test("rejects value exceeding 10", async () => {
      await settings.update.paymentProvider("stripe");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            booking_fee: "15",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(
          "Booking fee must be a number between 0 and 10",
        ),
        false,
      );
    });

    test("rejects negative value", async () => {
      await settings.update.paymentProvider("stripe");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            booking_fee: "-1",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(
          "Booking fee must be a number between 0 and 10",
        ),
        false,
      );
    });

    test("rejects non-numeric value", async () => {
      await settings.update.paymentProvider("stripe");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            booking_fee: "abc",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(
          "Booking fee must be a number between 0 and 10",
        ),
        false,
      );
    });

    test("settings page displays booking fee form when payment provider is set", async () => {
      await settings.update.paymentProvider("stripe");
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "Booking Fee", "booking_fee");
    });

    test("settings page hides booking fee form when no payment provider", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).not.toContain('id="settings-booking-fee"');
    });

    test("rejects missing booking_fee field", async () => {
      await settings.update.paymentProvider("stripe");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(
          "Booking fee must be a number between 0 and 10",
        ),
        false,
      );
    });

    test("logs activity when booking fee is changed", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          {
            booking_fee: "2.5",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message === "Booking fee set to 2.5%")).toBe(
        true,
      );
    });
  });
});
