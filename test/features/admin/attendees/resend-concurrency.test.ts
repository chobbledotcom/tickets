/**
 * Concurrent presses and the recovery claim.
 *
 * The claim leases the outstanding sides in one transaction, so only one
 * press can settle an owed side. A press whose selection is not owed sends
 * anyway, so two presses that both choose an owed side can both send it.
 */

/* jscpd:ignore-start -- imports */
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
import { configureTestEmail } from "#test-utils/email.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import {
  addWebhook,
  bookWebhookBuyer,
  expectResendPress,
  recoverAllSides,
  resend,
} from "./resend-press.ts";

/* jscpd:ignore-end */

describeWithEnv(
  "concurrent presses and the recovery claim",
  { db: true },
  () => {
    const fetch = stubFetchEachTest(() => new Response("{}"));

    test("a concurrent press keeps the owed badge while the default email goes out", async () => {
      // No press chooses the owed webhooks side, so no webhook fires. Each
      // press's claim leases the owed side and, because the press does not
      // select it, puts its flag straight back. Both presses default to the
      // email, so the buyer gets two, and the badge keeps saying the webhook
      // is still owed.
      await configureTestEmail();
      const { attendee } = await bookWebhookBuyer("Racing Buyer", 0, 1);

      const first = resend(attendee.id, "Racing Buyer");
      const second = await resend(attendee.id, "Racing Buyer");
      const { response } = await first;
      await expectResendPress(
        second.response,
        attendee.id,
        { buyerEmails: 2, webhooks: 0 },
        { email: 0, webhooks: 1 },
        fetch.calls,
      );
      expectRedirectWithFlash(
        `/admin/attendees/${attendee.id}/actions`,
        t("success.notification_resent"),
      )(response);
    });

    test("two concurrent presses that both choose the owed webhook each send it", async () => {
      // The claim no longer refuses a press whose choice is not owed, so two
      // presses that both select the webhook side both send it. The first
      // press owns the owed side and clears its flag; the other finds
      // nothing outstanding and sends as a forced press.
      await configureTestEmail();
      const { attendee } = await bookWebhookBuyer("Racing Hook Buyer", 0, 1);

      const first = resend(attendee.id, "Racing Hook Buyer", "webhooks");
      const second = await resend(attendee.id, "Racing Hook Buyer", "webhooks");
      const { response } = await first;
      await expectResendPress(
        second.response,
        attendee.id,
        { buyerEmails: 0, webhooks: 2 },
        { email: 0, webhooks: 0 },
        fetch.calls,
      );
      expectRedirectWithFlash(
        `/admin/attendees/${attendee.id}/actions`,
        t("success.notification_resent"),
      )(response);
    });

    test("a refused recovery keeps its flag up and stays retryable", async () => {
      await configureTestEmail();
      const { attendee } = await bookWebhookBuyer("Refused Buyer", 0, 1);
      let webhookAttempts = 0;
      fetch.reply(() => {
        webhookAttempts += 1;
        return webhookAttempts === 1
          ? new Response("no", { status: 500 })
          : new Response("{}");
      });

      const { response } = await resend(
        attendee.id,
        "Refused Buyer",
        "webhooks",
      );
      expectRedirectWithFlash(
        `/admin/attendees/${attendee.id}/actions`,
        t("success.notification_resent"),
      )(response);
      expect(await readPendingNotificationFlags(attendee.id)).toEqual({
        email: 0,
        webhooks: 1,
      });

      const second = await resend(attendee.id, "Refused Buyer", "webhooks");
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
        await expect(
          resend(attendee.id, "Activity Fault Buyer", "both"),
        ).rejects.toThrow("activity rejected");
        expect(await readPendingNotificationFlags(attendee.id)).toEqual({
          email: 2,
          webhooks: 1,
        });
      } finally {
        await execute("DROP TRIGGER IF EXISTS reject_resend_activity", []);
      }

      const second = await resend(attendee.id, "Activity Fault Buyer", "both");
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
        await expect(
          resend(attendee.id, "Restore Fault Buyer", "both"),
        ).rejects.toThrow("activity rejected");
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

      await recoverAllSides(attendee.id, "Email Provider Fault", "email");
    });

    test("a claim for a missing attendee claims nothing", async () => {
      // Another admin can delete the attendee between the route's load and
      // the claim. The claim then reads no row and claims nothing, so the
      // press has no owed side to settle.
      expect(await claimOutstandingNotificationFlags(999_999)).toEqual([]);
    });
  },
);
