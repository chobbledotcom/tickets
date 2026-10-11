import { type ActivityToLog, logActivities } from "#db/activity-log.ts";
import { settings } from "#db/settings.ts";
import { flatMap, mapNotNullish, unique } from "#fp";
import { t, withMessageGroups } from "#i18n";
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import {
  type RegistrationSendOptions,
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

const reportRegistrationDeliveryError = async (): Promise<void> => {
  const context = { code: ErrorCode.REGISTRATION_DELIVERY };
  logErrorLocal(context);
  await recordRegistrationDeliveryFailure();
  addPendingWork(sendNtfyError(context.code));
  addPendingWork(captureServerError(context));
};

const sendRegistrationNotifications = async (
  sends: RegistrationSendOptions,
): Promise<void> => {
  const [webhookResult, emailResult] = await Promise.allSettled([
    sendRegistrationWebhooks(sends.entries, sends.currency, sends.packageFacts),
    sendRegistrationEmails(sends),
  ]);
  const deliveries = [
    completedRegistrationDelivery(webhookResult),
    completedRegistrationDelivery(emailResult),
  ];
  const errors = flatMap((delivery: CompletedRegistrationDelivery) => [
    ...delivery.errors,
  ])(deliveries);
  if (errors.length > 0) {
    await reportRegistrationDeliveryError();
  } else if (deliveries.some(({ failed }) => failed)) {
    await recordRegistrationDeliveryFailure();
  }
  if (errors.length > 0) throw errors[0];
};

const queueRegistrationNotifications = async (
  sends: RegistrationSendOptions,
): Promise<void> => {
  try {
    const needsPackageFacts =
      registrationWebhookUrls(sends.entries).length > 0 ||
      registrationEmailDelivery(sends.entries) !== null;
    sends.packageFacts = needsPackageFacts
      ? (sends.packageFacts ??
        (await loadRegistrationPackageFacts(sends.entries)))
      : sends.packageFacts;
  } catch (error) {
    await reportRegistrationDeliveryError();
    throw error;
  }
  await sendRegistrationNotifications(sends);
};

/** Report background work that died after a booking was already paid for.
 * addPendingWork settles rejections silently. Without this the buyer keeps
 * the ticket and the operator never learns the site or its credit was lost. */
const reportAfterBookingFailure =
  (detail: string) =>
  (error: unknown): void => {
    logError({ code: ErrorCode.SITE_ASSIGNMENT, detail, error });
  };

/** What a booking passes to its notification queue. Everything is optional:
 * the plaintext free-text answers only the caller can hold, preloaded package
 * facts, extra activity-log lines, the renewal token's hash, and the entries
 * the site assignment sees. */
export interface NotifyRegistrationOptions {
  /** Await the confirmation webhook and email instead of parking them. A
   * work row's delivered stamp needs this: the stamp must prove the
   * notification finished, not that a pending promise exists. */
  awaitNotifications?: boolean | undefined;
  /** The buyer's typed free-text answers. The strings table keeps them sealed
   * to the owner key, which no notification path can spend, so the booking
   * request hands the plaintext it already holds to the confirmation email. */
  freeTexts?: FreeTextAnswers | undefined;
  /** Package facts the caller already loaded, so the queue does not re-read
   * them. */
  packageFacts?: RegistrationPackageFacts | undefined;
  /** Activity-log lines recorded beside the registration lines. */
  priorActivities?: readonly ActivityToLog[] | undefined;
  /** Cancels the notification's email send while it is in flight. A work
   * row's delivery bounds its send by the lease that names it, so a hung
   * transport cannot outlive the claim. */
  signal?: AbortSignal | undefined;
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
  await logActivities([
    ...(options.priorActivities ?? []),
    ...entries.map(({ listing, attendee }) => ({
      attendeeId: attendee.id,
      listing,
      message: `Attendee registered for '${listing.name}'`,
    })),
  ]);
  const currency = settings.currency;
  const notifications = queueRegistrationNotifications({
    currency,
    entries,
    freeTexts: options.freeTexts,
    packageFacts: options.packageFacts,
    signal: options.signal,
  });
  // A work row's completion marker must prove the notification finished, so
  // its delivery awaits the sends instead of parking them. A pending promise
  // dies with the request, and a crash after the marker skips the
  // notification on every later replay.
  if (options.awaitNotifications) {
    await notifications;
  } else {
    addPendingWork(notifications);
  }
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
