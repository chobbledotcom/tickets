import { logActivities } from "#db/activity-log.ts";
import {
  type PendingNotificationSide,
  pendingFlagStatement,
} from "#db/attendees/notification-flags.ts";
import { executeBatch } from "#db/client.ts";
import type { WebhookBookingSource } from "#db/contact-tokens.ts";
import { settings } from "#db/settings.ts";
import { flatMap, mapNotNullish, unique } from "#fp";
import { t, withMessageGroups } from "#i18n";
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import {
  buyerConfirmationAttempted,
  type RegistrationEmailResult,
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
> = async (entries, currency, source, suppliedFacts) => {
  const webhookUrls = registrationWebhookUrls(entries);
  if (webhookUrls.length === 0) return { failed: false };
  if (webhookUrls.length > MAX_REGISTRATION_WEBHOOK_URLS) {
    return { failed: true };
  }

  const facts = suppliedFacts ?? (await loadRegistrationPackageFacts(entries));
  const payload = buildWebhookPayload(
    entries,
    currency,
    source,
    facts.pricingByGroup,
  );
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

/** Deliver the manual add's webhooks and report a failed send the same way the
 * booking path does. Never throws: a failed webhook must not fail the save. */
const deliverManualAddWebhooks = async (
  entries: EmailEntry[],
): Promise<void> => {
  try {
    const { failed } = await sendRegistrationWebhooks(
      entries,
      settings.currency,
      "admin",
    );
    if (failed) await recordRegistrationDeliveryFailure();
  } catch {
    // A dead webhook endpoint is normal operation. The report is the
    // documented behavior, and the save stands.
    await reportRegistrationDeliveryError(true);
  }
};

/** Queue only the registration webhooks for attendees an admin added by hand —
 * no buyer email and no registration activity line. */
export const queueManualAddWebhooks = (entries: EmailEntry[]): void => {
  addPendingWork(deliverManualAddWebhooks(entries));
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
  source: WebhookBookingSource;
  packageFacts?: RegistrationPackageFacts | undefined;
  freeTexts?: FreeTextAnswers | undefined;
  clearPendingFlagsFor?: readonly number[] | undefined;
  recoverSides?: readonly PendingNotificationSide[] | undefined;
};

/** Which sides a send queues. A recovery queues only the sides it claimed.
 * Every other path queues both. */
const selectedSides = (
  recoverSides: readonly PendingNotificationSide[] | undefined,
): Record<PendingNotificationSide, boolean> => ({
  email: recoverSides === undefined || recoverSides.includes("email"),
  webhooks: recoverSides === undefined || recoverSides.includes("webhooks"),
});

/** Clears the pending flags a flag-owning send's sides earned, raises a
 * recovery's unearned sides back up, and reports what no raised flag
 * represents. */
const settleFlagOwningSend = async (
  clearPendingFlagsFor: readonly number[],
  attempted: { email: boolean; webhooks: boolean },
  webhookResult: PromiseSettledResult<RegistrationDeliveryResult>,
  emailResult: PromiseSettledResult<RegistrationEmailResult>,
  errors: unknown[],
  recoverSides?: readonly PendingNotificationSide[] | undefined,
): Promise<void> => {
  // The flags carry the failure: each side clears its own flag only when its
  // send was attempted and its far side accepted. A failed send leaves its
  // flag up for the admin. No failure activity line is written for a failure
  // a raised flag represents. The buyer confirmation's refusal is the email
  // flag's subject, and a webhook refusal is the webhooks flag's. The
  // owner's admin copy is no flag's subject, so its refusal keeps its
  // failure activity. The error is still reported, so an unexpected
  // rejection reaches the log and the alert.
  //
  // A failed clear batch leaves the flags up. The admin already reads a
  // raised flag as an owed send. Log the batch's failure, and do not mask
  // the delivery errors' report and throw.
  // The email side's per-message outcomes ride both settled states: the
  // fulfilled value, and a template error's enriched RegistrationDeliveryError.
  // Any other rejection threw before a delivery was attempted, so no side
  // speaks.
  const emailSide =
    emailResult.status === "fulfilled"
      ? emailResult.value
      : emailResult.reason instanceof RegistrationDeliveryError
        ? emailResult.reason
        : undefined;
  const buyerFlagClears =
    attempted.email && emailSide !== undefined && !emailSide.buyerFailed;
  const webhooksFlagClears =
    attempted.webhooks && acceptedDelivery(webhookResult);
  // A recovery's side that did not clear raises back up: the claim flipped
  // it down, and the flag must keep saying a send is owed.
  const statements = [
    ...(webhooksFlagClears
      ? [pendingFlagStatement("webhooks", clearPendingFlagsFor, "clear")]
      : []),
    ...(buyerFlagClears
      ? [pendingFlagStatement("email", clearPendingFlagsFor, "clear")]
      : []),
    ...(recoverSides?.includes("webhooks") && !webhooksFlagClears
      ? [pendingFlagStatement("webhooks", clearPendingFlagsFor, "raise")]
      : []),
    ...(recoverSides?.includes("email") && !buyerFlagClears
      ? [pendingFlagStatement("email", clearPendingFlagsFor, "raise")]
      : []),
  ];
  if (statements.length > 0) {
    await executeBatch(statements).catch(async (error) => {
      await logError({
        code: ErrorCode.DB_QUERY,
        detail: `The pending-flag settle batch failed: ${String(error)}`,
      });
    });
  }
  const ownerFailureUnrepresented =
    emailSide !== undefined ? emailSide.ownerFailed : false;
  if (errors.length > 0 || ownerFailureUnrepresented) {
    await reportRegistrationDeliveryError(ownerFailureUnrepresented);
  }
};

const sendRegistrationNotifications = async (
  send: RegistrationSend,
): Promise<void> => {
  const { entries, currency } = send;
  const sides = selectedSides(send.recoverSides);
  // A send that had nothing to attempt — no email config or buyer address,
  // no webhook URL — reports `failed: false`. That is not an acceptance: the
  // far side saw nothing, so it must not clear the flag that says a send is
  // owed. The email flag is the buyer's confirmation. The owner's admin copy
  // alone is a different message and never clears it.
  const webhooksAttempted =
    sides.webhooks && registrationWebhookUrls(entries).length > 0;
  const emailAttempted = sides.email && buyerConfirmationAttempted(entries);
  const skippedDelivery = (): RegistrationDeliveryResult => ({ failed: false });
  // A skipped email side is a hard non-attempt: a recovery that did not
  // claim the buyer's confirmation must never queue it.
  const skippedEmailDelivery = (): RegistrationEmailResult => ({
    buyerFailed: false,
    failed: false,
    ownerFailed: false,
  });
  const [webhookResult, emailResult] = await Promise.allSettled([
    sides.webhooks
      ? sendRegistrationWebhooks(
          entries,
          currency,
          send.source,
          send.packageFacts,
        )
      : Promise.resolve(skippedDelivery()),
    sides.email
      ? sendRegistrationEmails(
          entries,
          currency,
          send.packageFacts,
          send.freeTexts,
        )
      : Promise.resolve(skippedEmailDelivery()),
  ]);
  const deliveries = [
    completedRegistrationDelivery(webhookResult),
    completedRegistrationDelivery(emailResult),
  ];
  const errors = flatMap((delivery: CompletedRegistrationDelivery) => [
    ...delivery.errors,
  ])(deliveries);
  if (send.clearPendingFlagsFor !== undefined) {
    await settleFlagOwningSend(
      send.clearPendingFlagsFor!,
      { email: emailAttempted, webhooks: webhooksAttempted },
      webhookResult,
      emailResult,
      errors,
      send.recoverSides,
    );
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
  source: WebhookBookingSource,
  suppliedPackageFacts?: RegistrationPackageFacts,
  freeTexts?: FreeTextAnswers,
  clearPendingFlagsFor?: readonly number[] | undefined,
  recoverSides?: readonly PendingNotificationSide[] | undefined,
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
      recoverSides,
      source,
    }),
  );
};

/** The activity line a registration writes: one per booked listing. */
export const registeredActivityMessage = (listingName: string): string =>
  `Attendee registered for '${listingName}'`;

/** Report background work that died after a booking was already paid for.
 * addPendingWork settles rejections silently. Without this, the buyer keeps
 * the ticket and the operator never learns the site or its credit was lost. */
const reportAfterBookingFailure =
  (detail: string) =>
  (error: unknown): void => {
    logError({ code: ErrorCode.SITE_ASSIGNMENT, detail, error });
  };

/** What a booking passes to its notification queue. `source` is required, so
 * every booking path states how the booking was made. Everything else is
 * optional: the plaintext free-text answers only the caller can hold, preloaded
 * package facts, the entries the site assignment sees, the renewal token's
 * hash, and the attendees whose pending-notification flags each send clears. */
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
  /** The outstanding sides a recovery claimed for its attendee. Only these
   * sides queue, and a selected side whose send was refused or never ran has
   * its flag raised back up: the claim flipped it down, and the flag must
   * keep saying a send is owed. Leave this unset outside a recovery. */
  recoverSides?: readonly PendingNotificationSide[] | undefined;
  /** Entries only the site assignment sees, in place of `entries`. The resend
   * passes its refunded plan rows here, so a claim recorded on a line refunded
   * later still serves the buyer. Defaults to `entries`. */
  siteAssignmentEntries?: EmailEntry[] | undefined;
  /** The hashed renewal token, when this booking came from /renew. */
  siteTokenIndex?: string | undefined;
  /** How the booking was made. "public" is a booking the person made online,
   * "admin" is a booking an admin added by hand. "unknown" means no stored
   * contact history holds the answer, which a re-send reports. */
  source: WebhookBookingSource;
}

/** The shape both registration entry points share: the entries to notify and
 * the caller's options. */
type NotifyRegistration = (
  entries: EmailEntry[],
  options: NotifyRegistrationOptions,
) => Promise<void>;

/** Queue a registration's external sends: the confirmation email and the
 * registration webhooks, then built-site assignment and renewal processing.
 * The caller owns the registration's activity line, so a caller whose batch
 * already wrote it queues without a second copy. */
export const queueRegistrationSends: NotifyRegistration = async (
  entries,
  options,
) => {
  const currency = settings.currency;
  addPendingWork(
    queueRegistrationNotifications(
      entries,
      currency,
      options.source,
      options.packageFacts,
      options.freeTexts,
      options.clearPendingFlagsFor,
      options.recoverSides,
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

/** Record a registration and queue its external notifications. */
export const logAndNotifyRegistration: NotifyRegistration = async (
  entries,
  options,
) => {
  await logActivities(
    entries.map(({ listing, attendee }) => ({
      attendeeId: attendee.id,
      listing,
      message: registeredActivityMessage(listing.name),
    })),
  );
  await queueRegistrationSends(entries, options);
};
