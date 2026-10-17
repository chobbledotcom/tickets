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
  isEmailRequest,
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

    /** Run the badge race: the owner's chosen send is refused and restores
     * the badge, then the forced press's chosen send is accepted after
     * that restore. The owner's lease is held while the second press
     * claims nothing, so the second settle owns no claim. `onOwnerRestored`
     * observes the flags between the two settles. */
    const runBadgeRace = async (
      attendeeId: number,
      name: string,
      presses: { readonly owner: string; readonly forced: string },
      isRaceSide: (init: RequestInit | undefined) => boolean,
      onOwnerRestored: (flags: {
        email: number;
        webhooks: number;
      }) => Promise<void>,
    ): Promise<{ flags: { email: number; webhooks: number } }> => {
      let releaseOwner!: () => void;
      let releaseForced!: () => void;
      let ownerStarted!: () => void;
      let forcedStarted!: () => void;
      const wait = {
        forced: new Promise<void>((resolve) => {
          releaseForced = resolve;
        }),
        owner: new Promise<void>((resolve) => {
          releaseOwner = resolve;
        }),
      };
      const started = {
        forced: new Promise<void>((resolve) => {
          forcedStarted = resolve;
        }),
        owner: new Promise<void>((resolve) => {
          ownerStarted = resolve;
        }),
      };
      let raceSideCalls = 0;
      fetch.reply(async (_url, init) => {
        if (!isRaceSide(init)) return new Response("{}");
        raceSideCalls += 1;
        const side = raceSideCalls === 1 ? "owner" : "forced";
        if (side === "owner") ownerStarted();
        else forcedStarted();
        await wait[side];
        return side === "owner"
          ? new Response("no", { status: 500 })
          : new Response("{}");
      });

      const owner = resend(attendeeId, name, presses.owner);
      // The claim owner's delivery is in flight before the second press
      // runs, so the second press's claim captures nothing.
      await started.owner;
      const forced = resend(attendeeId, name, presses.forced);
      // The second press's empty claim has landed, and its accepted
      // delivery is in flight, before the owner's refusal restores the
      // badge.
      await started.forced;

      releaseOwner();
      const { response: ownerResponse } = await owner;
      await onOwnerRestored(await readPendingNotificationFlags(attendeeId));
      releaseForced();
      const { response: forcedResponse } = await forced;
      // Both presses report success: a refused send's failure rides the
      // settle, not the press.
      expectRedirectWithFlash(
        `/admin/attendees/${attendeeId}/actions`,
        t("success.notification_resent"),
      )(ownerResponse);
      expectRedirectWithFlash(
        `/admin/attendees/${attendeeId}/actions`,
        t("success.notification_resent"),
      )(forcedResponse);
      expect(raceSideCalls).toBe(2);
      return { flags: await readPendingNotificationFlags(attendeeId) };
    };

    test("a forced webhook accepted after a refused claim's restore leaves the badge up", async () => {
      // Press A claims the owed webhook side and holds its delivery open.
      // Press B then finds nothing outstanding, so its claim is empty and
      // its accepted send is a forced one. A's delivery is refused and
      // restores the badge. B's settlement must not touch that badge: B
      // never held the claim.
      await configureTestEmail();
      const { attendee } = await bookWebhookBuyer("Badge Race Buyer", 0, 1);
      const { flags } = await runBadgeRace(
        attendee.id,
        "Badge Race Buyer",
        { forced: "webhooks", owner: "webhooks" },
        () => true,
        async (restored) => {
          // The refusal restored the badge.
          expect(restored).toEqual({ email: 0, webhooks: 1 });
        },
      );
      // The forced send settles nothing: the badge stays as the refusal's
      // restore left it.
      expect(flags).toEqual({ email: 0, webhooks: 1 });
    });

    test("a forced email accepted after a refused claim's restore leaves the badge up", async () => {
      // The email side of the same race: press A claims both owed sides,
      // selects both, and holds its email delivery. Press B finds nothing
      // outstanding and its accepted email is a forced send. A's refused
      // email restores the badge; B's settlement must leave it alone.
      await configureTestEmail();
      const { attendee, listing } = await bookTestAttendeeWithFlags(
        "Email Badge Race",
        1,
        1,
      );
      await addWebhook(listing.id);
      const { flags } = await runBadgeRace(
        attendee.id,
        "Email Badge Race",
        { forced: "email", owner: "both" },
        (init) => init !== undefined && isEmailRequest(init),
        async (restored) => {
          // The webhook side cleared; the refused email's restore raised
          // the email badge again.
          expect(restored).toEqual({ email: 1, webhooks: 0 });
        },
      );
      expect(flags).toEqual({ email: 1, webhooks: 0 });
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
