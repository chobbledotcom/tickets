/**
 * Re-sending only what a recovery owes.
 *
 * The pending-notification flags are the record of what never went out, so a
 * recovery claims the outstanding sides and re-sends exactly those. The claim
 * also admits one recovery per attendee: a concurrent press finds nothing
 * outstanding. A refused side's flag rises again, so the badge keeps saying
 * a send is owed and the recovery stays retryable.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { claimOutstandingNotificationFlags } from "#db/attendees/notification-flags.ts";
import { execute } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookTestAttendeeWithFlags,
  readPendingNotificationFlags,
} from "#test-utils/db-helpers/attendees.ts";
import { updateTestListing } from "#test-utils/db-helpers/listings.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import {
  type FetchResponder,
  stubFetchEachTest,
} from "#test-utils/fetch-stub.ts";
import { adminFormPost } from "#test-utils/session.ts";

const resend = (attendeeId: number, name: string) =>
  adminFormPost(`/admin/attendees/${attendeeId}/resend-notification`, {
    confirm_identifier: name,
  });

const addWebhook = async (listingId: number): Promise<void> => {
  await updateTestListing(listingId, {
    webhookUrl: "https://hook.example.com/registration",
  });
};

/** A booking with both destinations configured and the named flag values. */
const bookWebhookBuyer = async (
  name: string,
  email: number,
  webhooks: number,
): Promise<ReturnType<typeof bookTestAttendeeWithFlags>> => {
  const booking = await bookTestAttendeeWithFlags(name, email, webhooks);
  await addWebhook(booking.listing.id);
  return booking;
};

/** A repaired provider and the final press: the resend succeeds and every
 * flag reads zero. */
const recoverAllSides = async (
  attendeeId: number,
  name: string,
): Promise<void> => {
  await settings.update.email.provider("resend");
  const repaired = await resend(attendeeId, name);
  expectRedirectWithFlash(
    `/admin/attendees/${attendeeId}/actions`,
    t("success.notification_resent"),
  )(repaired.response);
  expect(await readPendingNotificationFlags(attendeeId)).toEqual({
    email: 0,
    webhooks: 0,
  });
};

/** Whether this fetch call is the buyer's confirmation email request, which
 * every stub answers with an acceptance. */
const isEmailRequest = (init?: RequestInit): boolean => {
  const body = JSON.parse((init?.body as string) ?? "{}") as {
    to?: string[];
  };
  return Array.isArray(body.to);
};

describeWithEnv("re-sending only what a recovery owes", { db: true }, () => {
  const fetch = stubFetchEachTest(() => new Response("{}"));

  /** The webhook requests this suite's fetch saw, in order. */
  const webhookCalls = (): { args: readonly unknown[] }[] =>
    fetch.calls.filter(({ args }) =>
      String(args[0]).startsWith("https://hook.example.com"),
    );

  /** The confirmation email requests this suite's fetch saw. */
  const buyerEmailCalls = (): { args: readonly unknown[] }[] =>
    fetch.calls.filter(({ args }) => {
      const [, options] = args as [string, RequestInit];
      const body = JSON.parse(options.body as string) as { to?: string[] };
      return Array.isArray(body.to);
    });

  test("re-sends the webhook side alone and clears only its flag", async () => {
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Webhook Owed", 0, 1);
    const { response } = await resend(attendee.id, "Webhook Owed");

    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(response);
    expect(webhookCalls()).toHaveLength(1);
    expect(buyerEmailCalls()).toHaveLength(0);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 0,
    });
  });

  test("re-sends the email side alone and clears only its flag", async () => {
    await configureTestEmail();
    const { attendee } = await bookTestAttendeeWithFlags("Email Owed", 1, 0);
    const { response } = await resend(attendee.id, "Email Owed");

    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(response);
    expect(buyerEmailCalls()).toHaveLength(1);
    expect(webhookCalls()).toHaveLength(0);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 0,
    });
  });

  test("refuses a recovery when no send is owed", async () => {
    const { attendee } = await bookTestAttendeeWithFlags("All Set", 0, 0);
    const { response } = await resend(attendee.id, "All Set");

    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("attendees.resend_refused_nothing_owed"),
      false,
    )(response);
    expect(fetch.calls).toHaveLength(0);
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

    const { response } = await resend(attendee.id, "Admin Owed");
    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(response);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 2,
    });
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
      const { response } = await resend(attendee.id, "Settle Fault Buyer");
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
    const second = await resend(attendee.id, "Settle Fault Buyer");
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

    const { response } = await resend(attendee.id, "Provider Fault Buyer");
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

describeWithEnv("admitting one recovery per attendee", { db: true }, () => {
  /** The reply a webhook call gets this test. Email calls always accept. */
  let webhookReply: FetchResponder = () => new Response("{}");
  const fetch = stubFetchEachTest((url, init) =>
    isEmailRequest(init) ? new Response("{}") : webhookReply(url, init),
  );

  test("a concurrent second press admits nothing while the first holds the webhook open", async () => {
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Racing Buyer", 0, 1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    webhookReply = async () => {
      await held;
      return new Response("{}");
    };

    const first = resend(attendee.id, "Racing Buyer");
    const second = await resend(attendee.id, "Racing Buyer");
    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("attendees.resend_refused_nothing_owed"),
      false,
    )(second.response);
    release();
    const { response } = await first;
    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(response);

    const webhookAttempts = fetch.calls.filter(({ args }) =>
      String(args[0]).startsWith("https://hook.example.com"),
    );
    expect(webhookAttempts).toHaveLength(1);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 0,
    });
  });

  test("a refused recovery keeps its flag up and stays retryable", async () => {
    await configureTestEmail();
    const { attendee } = await bookWebhookBuyer("Refused Buyer", 0, 1);
    let webhookAttempts = 0;
    webhookReply = () => {
      webhookAttempts += 1;
      return webhookAttempts === 1
        ? new Response("no", { status: 500 })
        : new Response("{}");
    };

    const { response } = await resend(attendee.id, "Refused Buyer");
    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(response);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 1,
    });

    const second = await resend(attendee.id, "Refused Buyer");
    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(second.response);
    expect(webhookAttempts).toBe(2);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 0,
    });
  });

  test("a failed activity write releases the claimed flags", async () => {
    // The activity line lands before the delivery queues. When its write is
    // refused, the catch releases the lease, so both captured values go
    // back and a later resend after the obstacle is gone recovers them.
    await configureTestEmail();
    const { attendee, listing } = await bookTestAttendeeWithFlags(
      "Activity Fault Buyer",
      2,
      1,
    );
    await addWebhook(listing.id);
    // Activity messages are encrypted at insert, so the trigger cannot read
    // the words. The booking's own lines are already written, so any new
    // line for this attendee is the resend's.
    await execute(
      `CREATE TRIGGER reject_resend_activity BEFORE INSERT ON activity_log
       WHEN NEW.attendee_id = ${attendee.id}
       BEGIN
         SELECT RAISE(ABORT, 'activity rejected');
       END`,
      [],
    );
    try {
      // The refused activity write surfaces as the press's own rejection.
      await expect(resend(attendee.id, "Activity Fault Buyer")).rejects.toThrow(
        "activity rejected",
      );
      expect(await readPendingNotificationFlags(attendee.id)).toEqual({
        email: 2,
        webhooks: 1,
      });
    } finally {
      await execute("DROP TRIGGER IF EXISTS reject_resend_activity", []);
    }

    const second = await resend(attendee.id, "Activity Fault Buyer");
    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(second.response);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 0,
      webhooks: 0,
    });
  });

  test("a failed restore keeps the original failure and the lease", async () => {
    // The restore is a best-effort bookkeeping write. When the database
    // refuses it too, the press still fails with the original error — not
    // the restore's — and the lease stays held: the flags read zero while
    // the logged incident says a restore failed, for the operator to
    // repair.
    await configureTestEmail();
    const { attendee, listing } = await bookTestAttendeeWithFlags(
      "Restore Fault Buyer",
      2,
      1,
    );
    await addWebhook(listing.id);
    await execute(
      `CREATE TRIGGER reject_resend_activity BEFORE INSERT ON activity_log
       WHEN NEW.attendee_id = ${attendee.id}
       BEGIN
         SELECT RAISE(ABORT, 'activity rejected');
       END`,
      [],
    );
    await execute(
      `CREATE TRIGGER reject_flag_restore BEFORE UPDATE ON attendees
       WHEN NEW.id = ${attendee.id}
         AND (NEW.email_pending > OLD.email_pending
           OR NEW.webhooks_pending > OLD.webhooks_pending)
       BEGIN
         SELECT RAISE(ABORT, 'restore rejected');
       END`,
      [],
    );
    try {
      // The refused activity write surfaces as the press's own rejection,
      // not the restore's.
      await expect(resend(attendee.id, "Restore Fault Buyer")).rejects.toThrow(
        "activity rejected",
      );
      // The lease is still held: the claim's zeros stand because the
      // restore could not land.
      expect(await readPendingNotificationFlags(attendee.id)).toEqual({
        email: 0,
        webhooks: 0,
      });
    } finally {
      await execute("DROP TRIGGER IF EXISTS reject_resend_activity", []);
      await execute("DROP TRIGGER IF EXISTS reject_flag_restore", []);
    }
  });

  test("an unknown provider preserves an email-only recovery's flag", async () => {
    // With no webhook URL the protected preparation itself reads the email
    // setup and refuses an unknown stored provider. The lease releases
    // there, so the captured admin value goes back and a repaired provider
    // lets a later resend recover the side.
    await configureTestEmail();
    const { attendee } = await bookTestAttendeeWithFlags(
      "Email Provider Fault",
      2,
      0,
    );
    await settings.update.email.provider("unknown-provider");

    const { response } = await resend(attendee.id, "Email Provider Fault");
    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(response);
    expect(await readPendingNotificationFlags(attendee.id)).toEqual({
      email: 2,
      webhooks: 0,
    });

    await recoverAllSides(attendee.id, "Email Provider Fault");
  });

  test("a claim for a missing attendee claims nothing", async () => {
    // Another admin can delete the attendee between the route's load and
    // the claim. The claim then reads no row and claims nothing, so the
    // press refuses the way a nothing-owed press does.
    expect(await claimOutstandingNotificationFlags(999_999)).toEqual([]);
  });
});
