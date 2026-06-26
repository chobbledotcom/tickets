import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  adminGet,
  describeAdminSettings,
  expectFlash,
  expectHtmlResponse,
  getAllActivityLog,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
} from "#test-utils";

describeAdminSettings(() => {
  describe("POST /admin/settings/booking-fee", () => {
    testRequiresAuth("/admin/settings/booking-fee", {
      body: {
        booking_fee: "1.5",
      },
      method: "POST",
    });

    /** POST a booking-fee value with a fresh CSRF token + owner cookie. */
    const postBookingFee = async (value: string): Promise<Response> => {
      const csrf_token = await testCsrfToken();
      return handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          { booking_fee: value, csrf_token },
          await testCookie(),
        ),
      );
    };

    test("saves valid booking fee", async () => {
      const response = await postBookingFee("1.5");
      expect(response.status).toBe(302);
      expectFlash(response, "Booking fee set to 1.5%");

      expect(settings.bookingFee).toBe("1.5");
    });

    test("saves zero booking fee", async () => {
      const response = await postBookingFee("0");
      expect(response.status).toBe(302);
      expectFlash(response, "Booking fee set to 0%");
    });

    /** Assert the POST rejects `value` with the standard "must be a number
     *  between 0 and 10" flash. Sets the payment provider first so the form
     *  is visible — the route guards on a configured provider. */
    const expectRejectsOutOfRange = async (value: string): Promise<void> => {
      await settings.update.paymentProvider("stripe");
      const response = await postBookingFee(value);
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(
          "Booking fee must be a number between 0 and 10",
        ),
        false,
      );
    };

    test("rejects value exceeding 10", async () => {
      await expectRejectsOutOfRange("15");
    });

    test("rejects negative value", async () => {
      await expectRejectsOutOfRange("-1");
    });

    test("rejects non-numeric value", async () => {
      await expectRejectsOutOfRange("abc");
    });

    test("settings page displays booking fee form when payment provider is set", async () => {
      await settings.update.paymentProvider("stripe");
      const response = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, "Booking Fee", "booking_fee");
    });

    test("settings page hides booking fee form when no payment provider", async () => {
      const response = await adminGet("/admin/settings");
      const html = await response.text();
      expect(html).not.toContain('id="settings-booking-fee"');
    });

    test("rejects missing booking_fee field", async () => {
      await settings.update.paymentProvider("stripe");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/booking-fee",
          { csrf_token: await testCsrfToken() },
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
      await postBookingFee("2.5");

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message === "Booking fee set to 2.5%")).toBe(
        true,
      );
    });
  });
});
