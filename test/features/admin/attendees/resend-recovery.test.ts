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

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { sql } from "#db/sql.ts";
import { t } from "#i18n";
import {
  expectOneError,
  setBrokenConfirmationTemplate,
  withErrorSpy,
} from "#test/shared/webhook/helpers.ts";
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

describeWithEnv("re-sending only what a recovery owes", { db: true }, () => {
  const fetch = stubFetchEachTest(() => new Response("{}"));

  /** The delivery-failure activity lines this run recorded. */
  const deliveryFailures = async (): Promise<string[]> =>
    (await activityMessages()).filter(
      (message) => message === t("admin.log.registration_delivery_failed"),
    );

  /** One press and what it must move: the buyer the case books, the side it
   *  chooses, and the requests and flags it leaves. A case that wants a
   *  webhook books both destinations; the rest book the email alone. */
  type PressCase = {
    readonly buyer: string;
    readonly counts: {
      readonly buyerEmails: number;
      readonly webhooks: number;
    };
    readonly email: number;
    readonly flags: { readonly email: number; readonly webhooks: number };
    readonly hook: boolean;
    readonly name: string;
    readonly sides?: string;
    readonly webhooks: number;
  };

  /* jscpd:ignore-start -- a table of cases, not code */
  const pressCases: readonly PressCase[] = [
    {
      buyer: "Webhook Owed",
      counts: { buyerEmails: 0, webhooks: 1 },
      email: 0,
      flags: { email: 0, webhooks: 0 },
      hook: true,
      name: "re-sends the webhook side alone and clears only its flag",
      sides: "webhooks",
      webhooks: 1,
    },
    {
      buyer: "Email Owed",
      counts: { buyerEmails: 1, webhooks: 0 },
      email: 1,
      flags: { email: 0, webhooks: 0 },
      hook: false,
      name: "re-sends the email side alone and clears only its flag",
      webhooks: 0,
    },
    // The customer-service case: the buyer says the original email never
    // arrived, and the flags say every side went. The press sends the email
    // the page defaulted to and touches no flag, because nothing is owed.
    {
      buyer: "All Set",
      counts: { buyerEmails: 1, webhooks: 0 },
      email: 0,
      flags: { email: 0, webhooks: 0 },
      hook: false,
      name: "a resend with nothing owed still sends the default email side",
      webhooks: 0,
    },
    {
      buyer: "Hook Only",
      counts: { buyerEmails: 0, webhooks: 1 },
      email: 0,
      flags: { email: 0, webhooks: 0 },
      hook: true,
      name: "a resend with nothing owed can send the webhook side alone",
      sides: "webhooks",
      webhooks: 0,
    },
    {
      buyer: "Both Anyway",
      counts: { buyerEmails: 1, webhooks: 1 },
      email: 0,
      flags: { email: 0, webhooks: 0 },
      hook: true,
      name: "a resend with nothing owed can send both sides",
      sides: "both",
      webhooks: 0,
    },
    // The webhooks side is owed, but the press's default choice is the
    // email. The email goes out even though it was never owed, and the
    // claimed webhooks side keeps its flag: the badge keeps saying what is
    // still owed, and no webhook fires.
    {
      buyer: "Hook Withheld",
      counts: { buyerEmails: 1, webhooks: 0 },
      email: 0,
      flags: { email: 0, webhooks: 1 },
      hook: true,
      name: "a press that does not select an owed side keeps its badge and still sends the default email",
      webhooks: 1,
    },
  ];
  /* jscpd:ignore-end */

  for (const c of pressCases) {
    test(c.name, async () => {
      await configureTestEmail();
      const { attendee } = c.hook
        ? await bookWebhookBuyer(c.buyer, c.email, c.webhooks)
        : await bookTestAttendeeWithFlags(c.buyer, c.email, c.webhooks);
      const { response } = await resend(attendee.id, c.buyer, c.sides);

      await expectResendPress(
        response,
        attendee.id,
        c.counts,
        c.flags,
        fetch.calls,
      );
    });
  }

  /** One refused press and what it leaves behind: the buyer it books, the
   *  side it asks for, and the flash that turns the form away. */
  type RefusalCase = {
    readonly buyer: string;
    readonly email: number;
    /** The flash the press answers with, as the message key names it. */
    readonly flash: string;
    readonly flags: { readonly email: number; readonly webhooks: number };
    readonly name: string;
    readonly sides: string;
    readonly webhooks: number;
  };

  /* jscpd:ignore-start -- a table of cases, not code */
  const refusalCases: readonly RefusalCase[] = [
    // The page offers the webhook choice only when a webhook exists, so a
    // choice without one is a forged or stale form. The press is refused
    // before the claim, so the flags keep the values they carried in.
    {
      buyer: "No Hook",
      email: 1,
      flags: { email: 1, webhooks: 1 },
      flash: "attendees.resend_refused_no_webhook",
      name: "refuses a webhook choice when no webhook exists",
      sides: "webhooks",
      webhooks: 1,
    },
    {
      buyer: "Odd Choice",
      email: 1,
      flags: { email: 1, webhooks: 0 },
      flash: "attendees.resend_sides_invalid",
      name: "refuses a send choice the form does not offer",
      sides: "pigeon",
      webhooks: 0,
    },
  ];
  /* jscpd:ignore-end */

  for (const c of refusalCases) {
    test(c.name, async () => {
      await configureTestEmail();
      const { attendee } = await bookTestAttendeeWithFlags(
        c.buyer,
        c.email,
        c.webhooks,
      );
      const { response } = await resend(attendee.id, c.buyer, c.sides);

      expectRedirectWithFlash(
        `/admin/attendees/${attendee.id}/actions`,
        t(c.flash),
        false,
      )(response);
      expect(fetch.calls).toHaveLength(0);
      expect(await readPendingNotificationFlags(attendee.id)).toEqual(c.flags);
    });
  }

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

  /** A claimed owed email beside an unclaimed listing webhook: the webhook
   * refuses and the email channel answers. */
  const bookRefusingWebhookBuyer = async (name: string) => {
    await configureTestEmail();
    const { attendee, listing } = await bookTestAttendeeWithFlags(name, 1, 0);
    await addWebhook(listing.id);
    fetch.reply(async (_url, init) =>
      !init || !isEmailRequest(init)
        ? new Response("no", { status: 500 })
        : new Response("{}"),
    );
    return attendee;
  };

  /** The refused forced webhook's outcome: success flash, one failure
   * activity, and both flags cleared. */
  const expectForcedRefusalOutcome = async (
    attendee: { id: number },
    response: Response,
  ): Promise<void> => {
    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(response);
    expect(await deliveryFailures()).toHaveLength(1);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 0,
    });
  };

  test("a refused forced webhook beside a claimed cleared email records the failure", async () => {
    // The email side is owed and claimed: its acceptance clears its flag.
    // The webhook side is not owed, so the press forces it, and its
    // refusal has no claimed flag to represent it.
    const attendee = await bookRefusingWebhookBuyer("Mixed Race Refusal");

    const { response } = await resend(
      attendee.id,
      "Mixed Race Refusal",
      "both",
    );

    // The claimed email side still settled.
    await expectForcedRefusalOutcome(attendee, response);
  });

  test("a refused forced webhook beside a template-errored claimed email records the failure", async () => {
    // The claimed email side accepts the buyer email through the broken
    // template's fallback, but the render error still reaches the report.
    // The forced webhook's refusal must keep its activity: the template
    // error may not select the report branch that skips it.
    const attendee = await bookRefusingWebhookBuyer("Template Race Refusal");
    await setBrokenConfirmationTemplate();

    const { response, logs } = await withErrorSpy(async (errorSpy) => {
      const result = await resend(attendee.id, "Template Race Refusal", "both");
      return {
        logs: errorSpy.calls.map(({ args }) => String(args[0])),
        response: result.response,
      };
    });
    // The template incident remains reported beside the activity.
    expectOneError(logs, "E_REGISTRATION_DELIVERY");

    // The forced webhook was attempted and refused.
    const webhookAttempts = fetch.calls.filter(({ args }) =>
      String(args[0]).startsWith("https://hook.example.com"),
    );
    expect(webhookAttempts).toHaveLength(1);
    await expectForcedRefusalOutcome(attendee, response);
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
    const { attendee } = await bookWebhookBuyer("Settle Fault Buyer", 2, 1);
    await execute(
      sql`CREATE TRIGGER reject_admin_restore BEFORE UPDATE ON attendees
       WHEN NEW.email_pending = 2 AND OLD.email_pending = 0
       BEGIN
         SELECT RAISE(ABORT, 'email restore rejected');
       END`,
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
      await execute(sql`DROP TRIGGER IF EXISTS reject_admin_restore`);
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
