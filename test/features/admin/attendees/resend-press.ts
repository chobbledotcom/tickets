/** Presses and fixtures the re-send test files share. */

import { expect } from "@std/expect";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import {
  bookTestAttendeeWithFlags,
  readPendingNotificationFlags,
} from "#test-utils/db-helpers/attendees.ts";
import { updateTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** The press's form. The send choice is optional: a press without one uses
 * the page's default, the email. */
export const resend = (attendeeId: number, name: string, sides?: string) =>
  adminFormPost(`/admin/attendees/${attendeeId}/resend-notification`, {
    confirm_identifier: name,
    ...(sides === undefined ? {} : { resend_sides: sides }),
  });

export const addWebhook = async (listingId: number): Promise<void> => {
  await updateTestListing(listingId, {
    webhookUrl: "https://hook.example.com/registration",
  });
};

/** A booking with both destinations configured and the named flag values. */
export const bookWebhookBuyer = async (
  name: string,
  email: number,
  webhooks: number,
): Promise<ReturnType<typeof bookTestAttendeeWithFlags>> => {
  const booking = await bookTestAttendeeWithFlags(name, email, webhooks);
  await addWebhook(booking.listing.id);
  return booking;
};

/** A repaired provider and the final press: the resend succeeds and every
 * flag reads zero. The press chooses the named sides, so a recovery with
 * both sides owed recovers both. */
export const recoverAllSides = async (
  attendeeId: number,
  name: string,
  sides = "both",
): Promise<void> => {
  await settings.update.email.provider("resend");
  const repaired = await resend(attendeeId, name, sides);
  expectRedirectWithFlash(
    `/admin/attendees/${attendeeId}/actions`,
    t("success.notification_resent"),
  )(repaired.response);
  expect(await readPendingNotificationFlags(attendeeId)).toEqual({
    email: 0,
    webhooks: 0,
  });
};

/** The press's success flash, then what its fetch moved: the named counts
 * of webhook and buyer-email requests, and the flags it left. The counts
 * are cumulative over the stub's calls. */
export const expectResendPress = async (
  response: Response,
  attendeeId: number,
  counts: { webhooks: number; buyerEmails: number },
  flags: { email: number; webhooks: number },
  calls: readonly { args: readonly unknown[] }[],
): Promise<void> => {
  expectRedirectWithFlash(
    `/admin/attendees/${attendeeId}/actions`,
    t("success.notification_resent"),
  )(response);
  const webhookRequests = calls.filter(({ args }) =>
    String(args[0]).startsWith("https://hook.example.com"),
  );
  expect(webhookRequests).toHaveLength(counts.webhooks);
  const emailRequests = calls.filter(({ args }) =>
    isEmailRequest(args[1] as RequestInit),
  );
  expect(emailRequests).toHaveLength(counts.buyerEmails);
  expect(await readPendingNotificationFlags(attendeeId)).toEqual(flags);
};

/** Whether this fetch call is the buyer's confirmation email request: its
 * provider payload carries a `to` array, which the webhook payload lacks. */
export const isEmailRequest = (init: RequestInit): boolean => {
  const body = JSON.parse(init.body as string) as { to?: string[] };
  return Array.isArray(body.to);
};
