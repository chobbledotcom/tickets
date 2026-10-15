import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlash,
  expectHtmlResponse,
  redirectFormId,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminGet, testCookie, testCsrfToken } from "#test-utils/session.ts";
import { describeAdminSettings } from "#test-utils/settings.ts";

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
      expect(redirectFormId(response)).toBe("settings-booking-fee");

      expect(settings.bookingFee).toBe("1.5");
    });

    test("saves zero booking fee", async () => {
      const response = await postBookingFee("0");
      expect(response.status).toBe(302);
      expectFlash(response, "Booking fee set to 0%");
    });

    /** Assert the POST rejects `value` with the given flash. Sets the payment
     *  provider first so the form is visible — the route guards on a
     *  configured provider. */
    const expectRejects = async (
      value: string,
      message: string,
    ): Promise<void> => {
      await settings.update.paymentProvider("stripe");
      const response = await postBookingFee(value);
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining(message), false);
    };

    test("rejects a value above the declared maximum", async () => {
      await expectRejects("15", "Booking Fee (%) must be 10 or fewer");
    });

    test("rejects a value below the declared minimum", async () => {
      await expectRejects("-1", "Booking Fee (%) must be 0 or greater");
    });

    test("rejects a value the number type turns down", async () => {
      await expectRejects("abc", "Booking Fee (%) is invalid.");
    });

    test("saves the value the bounds validated for crafted number text", async () => {
      // "1e3" parses to 1000 — far past the declared max. The POST guard
      // refuses it before the extractor runs.
      await settings.update.paymentProvider("stripe");
      const before = settings.bookingFee;
      await expectRejects("1e3", "Booking Fee (%) must be 10 or fewer");
      expect(settings.bookingFee).toBe(before);
      // "0xA" is 10 to the schema's Number and 0 to a parseFloat.
      const response = await postBookingFee("0xA");
      expectFlash(response, "Booking fee set to 10%");
      expect(settings.bookingFee).toBe("10");
    });

    test("settings page displays booking fee form when payment provider is set", async () => {
      await settings.update.paymentProvider("stripe");
      const response = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, "Booking Fee", "booking_fee");
    });

    test("settings page hides booking fee form when no payment provider", async () => {
      const response = await adminGet("/admin/settings");
      const html = await response.text();
      assert(!html.includes('id="settings-booking-fee"'));
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
