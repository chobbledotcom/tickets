import { logActivities } from "#db/activity-log.ts";
import { clearPendingFlagStatement } from "#db/attendees/notification-flags.ts";
import { executeBatch } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { flatMap, mapNotNullish, unique } from "#fp";
import { t, withMessageGroups } from "#i18n";
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import {
  registrationEmailDelivery,
  sendRegistrationEmails,
} from "#shared/email/registration.ts";
import type { EmailEntry } from "#shared/email.ts";
import { fetchText, ResponseBodyTooLargeError } from "#shared/fetch.ts";
import { ErrorCode, logError, logErrorLocal } from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import {
  loadRegistrationPackageFacts,
  RegistrationDeliveryError,
  type RegistrationDeliveryResult,
  type RegistrationNotification,
  type RegistrationPackageFacts,
  waitForRegistrationDeliveries,
} from "#shared/registration-package-facts.ts";
import { captureServerError } from "#shared/sentry.ts";
import { assignAndNotifyBuiltSites } from "#shared/site-assignment.ts";
import { isSafeServerFetchUrl } from "#shared/url-safety.ts";
import {
  applyRenewalsForEntries,
  buildWebhookPayload,
  type RegistrationEntry,
  type WebhookPayload,
} from "#shared/webhook.ts";

export type WebhookDelivery =
  | { delivered: true }
  | {
      delivered: false;
      reason: "oversized_response" | "rejected" | "transport" | "unsafe_url";
    };

const MAX_REGISTRATION_WEBHOOK_URLS = 16;
const MAX_REGISTRATION_WEBHOOK_RESPONSE_BYTES = 64 * 1024;
const REGISTRATION_WEBHOOK_TIMEOUT_MS = 10_000;

/** Send one direct webhook request without blocking registration on failure. */
export const sendWebhook = async (
  webhookUrl: string,
  payload: WebhookPayload,
): Promise<WebhookDelivery> => {
  if (!isSafeServerFetchUrl(webhookUrl)) {
    return { delivered: false, reason: "unsafe_url" };
  }
  try {
    const { ok } = await fetchText(
      webhookUrl,
      {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(REGISTRATION_WEBHOOK_TIMEOUT_MS),
      },
      MAX_REGISTRATION_WEBHOOK_RESPONSE_BYTES,
    );
    return ok ? { delivered: true } : { delivered: false, reason: "rejected" };
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      return { delivered: false, reason: "oversized_response" };
    }
    if (
      !(error instanceof TypeError) &&
      !(error instanceof DOMException && error.name === "TimeoutError")
    ) {
      throw error;
    }
    return { delivered: false, reason: "transport" };
  }
};

const registrationWebhookUrls = (entries: RegistrationEntry[]): string[] =>
  unique(
    mapNotNullish(
      (entry: RegistrationEntry) => entry.listing.webhook_url || null,
    )(entries),
  );

/** Send one consolidated payload to each distinct registration webhook. */
export const sendRegistrationWebhooks: RegistrationNotification<
  RegistrationEntry
> = async (entries, currency, suppliedFacts) => {
  const webhookUrls = registrationWebhookUrls(entries);
  if (webhookUrls.length === 0) return { failed: false };
  if (webhookUrls.length > MAX_REGISTRATION_WEBHOOK_URLS) {
    return { failed: true };
  }

  const facts = suppliedFacts ?? (await loadRegistrationPackageFacts(entries));
  const payload = buildWebhookPayload(entries, currency, facts.pricingByGroup);
  return await waitForRegistrationDeliveries(
    webhookUrls.map((url) => sendWebhook(url, payload)),
  );
};

type CompletedRegistrationDelivery = RegistrationDeliveryResult & {
  errors: readonly unknown[];
};

const completedRegistrationDelivery = (
  result: PromiseSettledResult<RegistrationDeliveryResult>,
): CompletedRegistrationDelivery => {
  if (result.status === "fulfilled") {
    return { ...result.value, errors: [] };
  }
  return result.reason instanceof RegistrationDeliveryError
    ? { errors: result.reason.reasons, failed: result.reason.failed }
    : { errors: [result.reason], failed: false };
};

const recordRegistrationDeliveryFailure = async (): Promise<void> => {
  try {
    await withMessageGroups(["activity-log"], () =>
      logActivities([{ message: t("admin.log.registration_delivery_failed") }]),
    );
  } catch (error) {
    logErrorLocal({
      code: ErrorCode.DB_QUERY,
      detail: "Registration delivery failure activity write",
    });
    throw error;
  }
};

const reportRegistrationDeliveryError = async (
  recordFailure: boolean,
): Promise<void> => {
  const context = { code: ErrorCode.REGISTRATION_DELIVERY };
  logErrorLocal(context);
  if (recordFailure) await recordRegistrationDeliveryFailure();
  addPendingWork(sendNtfyError(context.code));
  addPendingWork(captureServerError(context));
};

/** Whether a send's far side accepted everything it was given: the send
 * settled, and none of its deliveries was refused. */
const acceptedDelivery = (
  result: PromiseSettledResult<RegistrationDeliveryResult>,
): boolean => result.status === "fulfilled" && !result.value.failed;

/** One registration send the queue carries, and the flags its sends own. */
type RegistrationSend = {
  entries: EmailEntry[];
  currency: string;
  packageFacts?: RegistrationPackageFacts | undefined;
  freeTexts?: FreeTextAnswers | undefined;
  clearPendingFlagsFor?: readonly number[] | undefined;
};

const sendRegistrationNotifications = async (
  send: RegistrationSend,
): Promise<void> => {
  const { entries, currency } = send;
  // A send that had nothing to attempt — no email config or address, no
  // webhook URL — reports `failed: false`. That is not an acceptance: the far
  // side saw nothing, so it must not clear the flag that says a send is owed.
  const webhooksAttempted = registrationWebhookUrls(entries).length > 0;
  const emailAttempted = registrationEmailDelivery(entries) !== null;
  const [webhookResult, emailResult] = await Promise.allSettled([
    sendRegistrationWebhooks(entries, currency, send.packageFacts),
    sendRegistrationEmails(
      entries,
      currency,
      send.packageFacts,
      send.freeTexts,
    ),
  ]);
  const deliveries = [
    completedRegistrationDelivery(webhookResult),
    completedRegistrationDelivery(emailResult),
  ];
  const errors = flatMap((delivery: CompletedRegistrationDelivery) => [
    ...delivery.errors,
  ])(deliveries);
  if (send.clearPendingFlagsFor !== undefined) {
    // The flags carry the failure: each side clears its own flag only when
    // its send was attempted and its far side accepted. A failed send leaves
    // its flag up for the admin. No failure activity line is written for a
    // booking whose sends own their flags. The error is still reported, so
    // an unexpected rejection reaches the log and the alert.
    await executeBatch([
      ...(webhooksAttempted && acceptedDelivery(webhookResult)
        ? [clearPendingFlagStatement("webhooks", send.clearPendingFlagsFor)]
        : []),
      ...(emailAttempted && acceptedDelivery(emailResult)
        ? [clearPendingFlagStatement("email", send.clearPendingFlagsFor)]
        : []),
    ]);
    if (errors.length > 0) await reportRegistrationDeliveryError(false);
  } else if (errors.length > 0) {
    await reportRegistrationDeliveryError(true);
  } else if (deliveries.some(({ failed }) => failed)) {
    await recordRegistrationDeliveryFailure();
  }
  if (errors.length > 0) throw errors[0];
};

const queueRegistrationNotifications = async (
  entries: EmailEntry[],
  currency: string,
  suppliedPackageFacts?: RegistrationPackageFacts,
  freeTexts?: FreeTextAnswers,
  clearPendingFlagsFor?: readonly number[] | undefined,
): Promise<void> => {
  let packageFacts: RegistrationPackageFacts | undefined;
  try {
    const needsPackageFacts =
      registrationWebhookUrls(entries).length > 0 ||
      registrationEmailDelivery(entries) !== null;
    packageFacts = needsPackageFacts
      ? (suppliedPackageFacts ?? (await loadRegistrationPackageFacts(entries)))
      : suppliedPackageFacts;
  } catch (error) {
    await reportRegistrationDeliveryError(clearPendingFlagsFor === undefined);
    throw error;
  }
  addPendingWork(
    sendRegistrationNotifications({
      clearPendingFlagsFor,
      currency,
      entries,
      freeTexts,
      packageFacts,
    }),
  );
};

/** The activity line a registration writes: one per booked listing. */
export const registeredActivityMessage = (listingName: string): string =>
  `Attendee registered for '${listingName}'`;

/** Report background work that died after a booking was already paid for.
 * addPendingWork settles rejections silently, so without this the buyer keeps
 * the ticket and the operator never learns the site or its credit was lost. */
const reportAfterBookingFailure =
  (detail: string) =>
  (error: unknown): void => {
    logError({ code: ErrorCode.SITE_ASSIGNMENT, detail, error });
  };

/** What a booking passes to its notification queue. Everything is optional:
 * the plaintext free-text answers only the caller can hold, preloaded package
 * facts, the entries the site assignment sees, the renewal token's hash, and
 * the attendees whose pending-notification flags each send clears. */
export interface NotifyRegistrationOptions {
  /** The attendees whose pending-notification flags this queue's sends own:
   * the email send clears `email_pending` when its far side accepts, the
   * webhook send clears `webhooks_pending` the same way. A failed send leaves
   * its flag up, so the flags carry the failure and no failure activity line
   * is written. Callers whose bookings carry no flags leave this unset, and a
   * failed send keeps writing the failure line it always did. */
  clearPendingFlagsFor?: readonly number[] | undefined;
  /** The buyer's typed free-text answers. The strings table keeps them sealed
   * to the owner key, which no notification path can spend, so the booking
   * request hands the plaintext it already holds to the confirmation email. */
  freeTexts?: FreeTextAnswers | undefined;
  /** Package facts the caller already loaded, so the queue does not re-read
   * them. */
  packageFacts?: RegistrationPackageFacts | undefined;
  /** Entries only the site assignment sees, in place of `entries`. The resend
   * passes its refunded plan rows here, so a claim recorded on a line refunded
   * later still serves the buyer. Defaults to `entries`. */
  siteAssignmentEntries?: EmailEntry[] | undefined;
  /** The hashed renewal token, when this booking came from /renew. */
  siteTokenIndex?: string | undefined;
}

/** Record a registration and queue its external notifications. */
export const logAndNotifyRegistration = async (
  entries: EmailEntry[],
  options: NotifyRegistrationOptions = {},
): Promise<void> => {
  await logActivities(
    entries.map(({ listing, attendee }) => ({
      attendeeId: attendee.id,
      listing,
      message: registeredActivityMessage(listing.name),
    })),
  );
  const currency = settings.currency;
  addPendingWork(
    queueRegistrationNotifications(
      entries,
      currency,
      options.packageFacts,
      options.freeTexts,
      options.clearPendingFlagsFor,
    ),
  );
  addPendingWork(
    assignAndNotifyBuiltSites(options.siteAssignmentEntries ?? entries).catch(
      reportAfterBookingFailure(
        "Site assignment failed after a completed booking",
      ),
    ),
  );
  addPendingWork(
    applyRenewalsForEntries(entries, options.siteTokenIndex).catch(
      reportAfterBookingFailure(
        "Renewal was not applied after a completed booking",
      ),
    ),
  );
};
