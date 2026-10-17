/**
 * Re-sending only what a recovery owes.
 *
 * The pending-notification flags are the record of what never went out, so
 * the claim captures the outstanding sides and the send settles exactly the
 * claimed sides the press selected. The press's send choice decides what
 * goes out; the claim decides what is owed. A side the press does not select
 * keeps its flag, so the badge keeps saying a send is owed. A press whose
 * selection is not owed sends anyway: that is the customer-service resend.
 */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookTestAttendeeWithFlags,
  readPendingNotificationFlags,
} from "#test-utils/db-helpers/attendees.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import {
  addWebhook,
  bookWebhookBuyer,
  expectResendPress,
  isEmailRequest,
  recoverAllSides,
  resend,
} from "./resend-press.ts";

/* jscpd:ignore-end */

describeWithEnv("re-sending only what a recovery owes", { db: true }, () => {
  const fetch = stubFetchEachTest(() => new Response("{}"));

  /** The delivery-failure activity lines this run recorded. */
  const deliveryFailures = async (): Promise<string[]> =>
    (await activityMessages()).filter(
      (message) => message === t("admin.log.registration_delivery_failed"),
    );

  test("re-sends the webhook side alone and clears only its flag", async () => {
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Webhook Owed", 0, 1);
    const { response } = await resend(attendee.id, "Webhook Owed", "webhooks");

    await expectResendPress(
      response,
      attendee.id,
      { buyerEmails: 0, webhooks: 1 },
      { email: 0, webhooks: 0 },
      fetch.calls,
    );
  });

  test("re-sends the email side alone and clears only its flag", async () => {
    await configureTestEmail();
    const { attendee } = await bookTestAttendeeWithFlags("Email Owed", 1, 0);
    const { response } = await resend(attendee.id, "Email Owed");

    await expectResendPress(
      response,
      attendee.id,
      { buyerEmails: 1, webhooks: 0 },
      { email: 0, webhooks: 0 },
      fetch.calls,
    );
  });

  test("a resend with nothing owed still sends the default email side", async () => {
    // The customer-service case: the buyer says the original email never
    // arrived, and the flags say every side went. The press sends the email
    // the page defaulted to and touches no flag, because nothing is owed.
    await configureTestEmail();
    const { attendee } = await bookTestAttendeeWithFlags("All Set", 0, 0);
    const { response } = await resend(attendee.id, "All Set");

    await expectResendPress(
      response,
      attendee.id,
      { buyerEmails: 1, webhooks: 0 },
      { email: 0, webhooks: 0 },
      fetch.calls,
    );
  });

  test("a resend with nothing owed can send the webhook side alone", async () => {
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Hook Only", 0, 0);
    const { response } = await resend(attendee.id, "Hook Only", "webhooks");

    await expectResendPress(
      response,
      attendee.id,
      { buyerEmails: 0, webhooks: 1 },
      { email: 0, webhooks: 0 },
      fetch.calls,
    );
  });

  test("a resend with nothing owed can send both sides", async () => {
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Both Anyway", 0, 0);
    const { response } = await resend(attendee.id, "Both Anyway", "both");

    await expectResendPress(
      response,
      attendee.id,
      { buyerEmails: 1, webhooks: 1 },
      { email: 0, webhooks: 0 },
      fetch.calls,
    );
  });

  test("a press that does not select an owed side keeps its badge and still sends the default email", async () => {
    // The webhooks side is owed, but the press's default choice is the
    // email. The email goes out even though it was never owed, and the
    // claimed webhooks side keeps its flag: the badge keeps saying what is
    // still owed, and no webhook fires.
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Hook Withheld", 0, 1);
    const { response } = await resend(attendee.id, "Hook Withheld");

    await expectResendPress(
      response,
      attendee.id,
      { buyerEmails: 1, webhooks: 0 },
      { email: 0, webhooks: 1 },
      fetch.calls,
    );
  });

  test("refuses a webhook choice when no webhook exists", async () => {
    // The page offers the webhook choice only when a webhook exists, so a
    // choice without one is a forged or stale form. The press is refused
    // before the claim, so the flags keep the values they carried in.
    await configureTestEmail();
    const { attendee } = await bookTestAttendeeWithFlags("No Hook", 1, 1);
    const { response } = await resend(attendee.id, "No Hook", "webhooks");

    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("attendees.resend_refused_no_webhook"),
      false,
    )(response);
    expect(fetch.calls).toHaveLength(0);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 1,
      webhooks: 1,
    });
  });

  test("refuses a send choice the form does not offer", async () => {
    await configureTestEmail();
    const { attendee } = await bookTestAttendeeWithFlags("Odd Choice", 1, 0);
    const { response } = await resend(attendee.id, "Odd Choice", "pigeon");

    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("attendees.resend_sides_invalid"),
      false,
    )(response);
    expect(fetch.calls).toHaveLength(0);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 1,
      webhooks: 0,
    });
  });

  test("a refused forced webhook records the delivery failure", async () => {
    // Nothing is owed, so no flag represents the refusal: the failure
    // activity is the only signal the forced send's delivery died. The
    // flags stay at zero, and the press still reports success.
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Forced Hook Refused", 0, 0);
    fetch.reply(() => new Response("no", { status: 500 }));

    const { response } = await resend(
      attendee.id,
      "Forced Hook Refused",
      "webhooks",
    );

    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(response);
    const failures = await deliveryFailures();
    expect(failures).toHaveLength(1);
    const webhookAttempts = fetch.calls.filter(({ args }) =>
      String(args[0]).startsWith("https://hook.example.com"),
    );
    expect(webhookAttempts).toHaveLength(1);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 0,
    });
  });

  test("a refused forced webhook beside a claimed cleared email records the failure", async () => {
    // The email side is owed and claimed: its acceptance clears its flag.
    // The webhook side is not owed, so the press forces it, and its
    // refusal has no claimed flag to represent it.
    await configureTestEmail();
    const { attendee, listing } = await bookTestAttendeeWithFlags(
      "Mixed Race Refusal",
      1,
      0,
    );
    await addWebhook(listing.id);
    fetch.reply(async (_url, init) =>
      !init || !isEmailRequest(init)
        ? new Response("no", { status: 500 })
        : new Response("{}"),
    );

    const { response } = await resend(
      attendee.id,
      "Mixed Race Refusal",
      "both",
    );

    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(response);
    const failures = await deliveryFailures();
    expect(failures).toHaveLength(1);
    // The claimed email side still settled.
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 0,
    });
  });

  test("a refused send keeps an admin-added badge's value", async () => {
    // An admin-added attendee's owed flag stores 2 (orange badge). The
    // refused webhook's release must put 2 back, not the online value 1.
    await configureTestEmail();
    const { attendee, listing } = await bookTestAttendeeWithFlags(
      "Admin Owed",
      0,
      2,
    );
    await addWebhook(listing.id);
    fetch.reply(new Response("no", { status: 500 }));

    const { response } = await resend(attendee.id, "Admin Owed", "webhooks");
    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(response);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 2,
    });
    // The badge carries the failure: a claimed side's refusal records no
    // separate failure activity.
    expect(await deliveryFailures()).toHaveLength(0);
  });

  test("a failed settle batch still restores the refused side for a later resend", async () => {
    // Both sides are owed with captured values 2 and 1. Both sends are
    // refused, and a trigger rejects the email side's restore, so the
    // settle batch dies. The settle's own recovery then restores each side
    // separately: the webhooks side lands, the email side's failure is
    // logged with its name, and a later real resend recovers the webhooks
    // side.
    await configureTestEmail();
    const { attendee, listing } = await bookTestAttendeeWithFlags(
      "Settle Fault Buyer",
      2,
      1,
    );
    await addWebhook(listing.id);
    await execute(
      `CREATE TRIGGER reject_admin_restore BEFORE UPDATE ON attendees
       WHEN NEW.email_pending = 2 AND OLD.email_pending = 0
       BEGIN
         SELECT RAISE(ABORT, 'email restore rejected');
       END`,
      [],
    );
    fetch.reply(() => new Response("no", { status: 500 }));
    try {
      const { response } = await resend(
        attendee.id,
        "Settle Fault Buyer",
        "both",
      );
      expectRedirectWithFlash(
        `/admin/attendees/${attendee.id}/actions`,
        t("success.notification_resent"),
      )(response);
    } finally {
      await execute("DROP TRIGGER IF EXISTS reject_admin_restore", []);
    }
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 1,
    });

    fetch.reply(new Response("{}"));
    const before = fetch.calls.length;
    const second = await resend(attendee.id, "Settle Fault Buyer", "webhooks");
    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(second.response);
    // The recovery re-sends only the outstanding webhooks side: one new
    // webhook request, no buyer email, and both flags finally down.
    expect(fetch.calls.length).toBe(before + 1);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 0,
    });
  });

  test("an unknown provider preserves both owed flags until it is repaired", async () => {
    // A webhook URL makes the protected preparation short-circuit past the
    // email setup, so the unknown provider throws right before the sends
    // start. The lease must release there: both captured values go back,
    // nothing is sent, and a repaired provider lets a later resend recover
    // both sides.
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Provider Fault Buyer", 2, 1);
    await settings.update.email.provider("unknown-provider");
    const before = fetch.calls.length;

    const { response } = await resend(
      attendee.id,
      "Provider Fault Buyer",
      "both",
    );
    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(response);
    // No send went out: the provider refusal happens before dispatch.
    expect(fetch.calls.length).toBe(before);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 2,
      webhooks: 1,
    });

    await recoverAllSides(attendee.id, "Provider Fault Buyer");
  });
});
