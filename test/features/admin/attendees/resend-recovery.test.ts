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
});
