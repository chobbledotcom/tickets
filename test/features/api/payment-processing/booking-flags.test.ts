import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import type { ValidatedSession } from "#routes/api/webhook-types.ts";
import { withErrorSpy } from "#test/shared/webhook/helpers.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { useFetchStub } from "#test-utils/mocks.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import {
  bookingIntent,
  readBookingFlags,
  singleListingPayment,
  singleListingPaymentWithWebhook,
  trustedPayment,
} from "./index/helpers.ts";

describeWithEnv("payment processing pending flags", { db: true }, () => {
  const fetch = useFetchStub();

  /** Runs one paid checkout, then reads the booking's one attendee's
   * pending flags back. */
  const payAndFlags = async (
    id: string,
    data: ValidatedSession,
    listingId: number,
  ): Promise<{ email: number; webhooks: number }> => {
    await withRequestContext(async () => {
      expect((await processPaymentSession(id, data)).success).toBe(true);
    });
    return readBookingFlags(listingId);
  };

  /** Book a paid listing, read its one attendee's pending flags back. */
  const bookedFlags = async (
    id: string,
    withWebhook = false,
  ): Promise<{ email: number; webhooks: number }> => {
    const { data, listing } = await (withWebhook
      ? singleListingPaymentWithWebhook(id, 1000)
      : singleListingPayment(id, 1000));
    await configureTestEmail();
    return payAndFlags(id, data, listing.id);
  };

  /** Refuses every Resend delivery addressed to one reader; the rest of the
   * provider traffic is accepted. */
  const refuseEmailsTo = (refused: string): void => {
    fetch.restubFetch((url, init) => {
      if (!url.includes("resend.com")) return new Response();
      const body = JSON.parse(String(init?.body)) as { to: string[] };
      return new Response("", {
        status: body.to[0] === refused ? 500 : 200,
      });
    });
  };

  /** Counts the booking failure's activity lines. */
  const deliveryFailureLines = async (): Promise<number> =>
    (await getAllActivityLog()).filter(
      (entry) => entry.message === "Registration notification delivery failed.",
    ).length;

  test("a booking on a listing that collects no email sets no flags", async () => {
    // The listing's contact fields name no email, and no webhook is set, so
    // the booking owes no send and both flags stay down.
    const listing = await createTestListing({
      // The empty fields string collects no contact fields, so the booking
      // owes no confirmation email.
      fields: "",
      maxAttendees: 5,
      unitPrice: 1000,
    });
    const data = trustedPayment(
      "cs_direct_no_email",
      bookingIntent([{ e: listing.id, p: 1000, q: 1 }]),
      1000,
    );
    await configureTestEmail();
    await withRequestContext(async () => {
      expect(
        (await processPaymentSession("cs_direct_no_email", data)).success,
      ).toBe(true);
    });
    expect(await readBookingFlags(listing.id)).toEqual({
      email: 0,
      webhooks: 0,
    });
  });

  test("a paid booking's pending flags clear when its sends are accepted", async () => {
    // Both sends were accepted, so both flags are down. The webhook fixture
    // puts a webhook on the listing, so the webhook flag is set by the
    // booking and cleared by the accepted send, not merely never raised.
    expect(await bookedFlags("cs_direct_flags_webhook", true)).toEqual({
      email: 0,
      webhooks: 0,
    });
  });

  test("a paid booking's flags stay up when the sends are refused", async () => {
    // A provider that accepts nothing: every send the booking owes is
    // refused, so both flags stay up for the admin.
    fetch.restubFetch(() => new Response("", { status: 500 }));
    expect(await bookedFlags("cs_direct_flags_refused", true)).toEqual({
      email: 1,
      webhooks: 1,
    });
  });

  test("an owner-copy refusal no flag represents keeps its failure activity", async () => {
    // The listing collects no email and sets no webhook, so the booking
    // raises no flags. The configured business email makes the owner copy
    // the only refused send: its refusal is no pending flag's subject, so
    // the failure activity survives even though the send owns the flags.
    const listing = await createTestListing({
      // The empty fields string collects no contact fields, so the booking
      // raises no pending-email flag.
      fields: "",
      maxAttendees: 5,
      unitPrice: 1000,
    });
    await configureTestEmail({ businessEmail: "owner@example.com" });
    refuseEmailsTo("owner@example.com");
    const data = trustedPayment(
      "cs_owner_copy_refusal",
      bookingIntent([{ e: listing.id, p: 1000, q: 1 }]),
      1000,
    );
    expect(
      await payAndFlags("cs_owner_copy_refusal", data, listing.id),
    ).toEqual({
      email: 0,
      webhooks: 0,
    });
    expect(await deliveryFailureLines()).toBe(1);
  });

  test("the buyer flag clears when only the owner copy is refused", async () => {
    // The buyer's confirmation was accepted; the owner copy's refusal is a
    // different message and must not keep the buyer's flag up. The owner
    // copy's refusal reports through the failure activity instead.
    await configureTestEmail({ businessEmail: "owner@example.com" });
    refuseEmailsTo("owner@example.com");
    expect(await bookedFlags("cs_owner_copy_only_refused", true)).toEqual({
      email: 0,
      webhooks: 0,
    });
    expect(await deliveryFailureLines()).toBe(1);
  });

  test("the buyer flag stays up when only the owner copy is accepted", async () => {
    // The buyer's confirmation was refused; the owner copy's acceptance
    // must not clear the buyer's flag. The raised flag carries the buyer
    // refusal, so no failure activity is written.
    await configureTestEmail({ businessEmail: "owner@example.com" });
    refuseEmailsTo("buyer@example.com");
    expect(await bookedFlags("cs_buyer_copy_only_refused", true)).toEqual({
      email: 1,
      webhooks: 0,
    });
    expect(await deliveryFailureLines()).toBe(0);
  });

  test("the buyer flag clears when a template error rides the send", async () => {
    // The stored confirmation template fails to render: the fallback still
    // delivers the buyer's message. The buyer flag clears on that
    // acceptance, and the template incident keeps its error report.
    const { data, listing } = await singleListingPaymentWithWebhook(
      "cs_template_fallback_flags",
      1000,
    );
    await configureTestEmail();
    await settings.update.email.template(
      "confirmation",
      "subject",
      "{{ subject | missing_filter }}",
    );
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);
    const logs = await withErrorSpy(async (errorSpy) => {
      await withRequestContext(async () => {
        expect(
          (await processPaymentSession("cs_template_fallback_flags", data))
            .success,
        ).toBe(true);
      });
      return errorSpy.calls.map(({ args }) => String(args[0]));
    });
    expect(await readBookingFlags(listing.id)).toEqual({
      email: 0,
      webhooks: 0,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("E_REGISTRATION_DELIVERY");
  });

  test("a refused owner copy keeps its activity when a template error rides the send", async () => {
    // The confirmation template fails to render and the owner copy is
    // refused: the buyer's acceptance still clears its flag, and the owner
    // copy's refusal keeps its failure activity beside the incident.
    const { data, listing } = await singleListingPaymentWithWebhook(
      "cs_template_owner_refused",
      1000,
    );
    await configureTestEmail({ businessEmail: "owner@example.com" });
    await settings.update.email.template(
      "confirmation",
      "subject",
      "{{ subject | missing_filter }}",
    );
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);
    refuseEmailsTo("owner@example.com");
    await withRequestContext(async () => {
      expect(
        (await processPaymentSession("cs_template_owner_refused", data))
          .success,
      ).toBe(true);
    });
    expect(await readBookingFlags(listing.id)).toEqual({
      email: 0,
      webhooks: 0,
    });
    expect(await deliveryFailureLines()).toBe(1);
  });
});
