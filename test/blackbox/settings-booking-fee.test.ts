import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { App } from "#test/blackbox/driver.ts";
import {
  activityLog,
  boxText,
  followed,
  loggedIn,
  pageAfter,
  redirectOf,
  type SettingsForm,
  send,
  testFormGuards,
} from "#test/blackbox/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const BOOKING_FEE: SettingsForm = {
  action: "/admin/settings/booking-fee",
  field: "bookingFee",
  page: "/admin/settings",
};

/** The owner who chose Stripe. The page shows the form only then. */
const withProvider = async (): Promise<App> => {
  const app = await loggedIn();
  redirectOf(
    await app.submit(
      "/admin/settings",
      { paymentProvider: "stripe" },
      "/admin/settings/payment-provider",
    ),
  );
  return app;
};

const feeNow = async (app: App): Promise<string> =>
  boxText((await app.get(BOOKING_FEE.page)).html, BOOKING_FEE.field);

/** The owner saves `value` and reads the message on the next page. */
const save = (app: App, value: string | null): Promise<string> =>
  pageAfter(app, BOOKING_FEE, { bookingFee: value });

/** Each value that the form refuses, with the reason that the page gives. */
const REFUSED: [value: string | null, reason: string][] = [
  ["15", "Booking Fee (%) must be 10 or fewer"],
  ["-1", "Booking Fee (%) must be 0 or greater"],
  ["abc", "Booking Fee (%) is invalid."],
  ["1e3", "Booking Fee (%) must be 10 or fewer"],
  [null, "Booking fee must be a number between 0 and 10"],
];

describeWithEnv("the setting /admin/settings/booking-fee", { db: true }, () => {
  test("the page hides the form until a payment provider is chosen", async () => {
    const app = await loggedIn();
    const before = (await app.get(BOOKING_FEE.page)).html;
    expect(before).not.toContain('id="settings-booking-fee"');

    const after = (await (await withProvider()).get(BOOKING_FEE.page)).html;
    expect(after).toContain("Booking Fee");
    expect(boxText(after, BOOKING_FEE.field)).toBe("0");
  });

  test("a save says so beside its form, stays in the box, and shows in the activity log", async () => {
    const app = await withProvider();
    const sent = await send(app, BOOKING_FEE, { bookingFee: "1.5" });
    const to = new URL(redirectOf(sent), "http://localhost");
    expect(to.searchParams.get("form")).toBe("settings-booking-fee");
    expect((await followed(app, sent)).html).toContain(
      "Booking fee set to 1.5%",
    );
    expect(await feeNow(app)).toBe("1.5");
    expect(await activityLog(app)).toContain("Booking fee set to 1.5%");
  });

  test("a fee of zero saves after another fee", async () => {
    const app = await withProvider();
    await save(app, "2.5");
    expect(await save(app, "0")).toContain("Booking fee set to 0%");
    expect(await feeNow(app)).toBe("0");
  });

  for (const [value, reason] of REFUSED) {
    test(`refuses ${value ?? "no value"} and keeps the saved fee`, async () => {
      const app = await withProvider();
      await save(app, "2.5");
      expect(await save(app, value)).toContain(reason);
      expect(await feeNow(app)).toBe("2.5");
    });
  }

  test("number text in another base saves as the number that the limits checked", async () => {
    const app = await withProvider();
    expect(await save(app, "0xA")).toContain("Booking fee set to 10%");
    expect(await feeNow(app)).toBe("10");
  });

  testFormGuards(BOOKING_FEE, "1.5", feeNow, "0", withProvider);
});
