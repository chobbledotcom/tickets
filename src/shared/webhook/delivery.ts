import { type ActivityToLog, logActivities } from "#db/activity-log.ts";
import { queueRegistrationEmails } from "#db/registration-email-work.ts";
import { settings } from "#db/settings.ts";
import { flatMap, mapNotNullish, unique } from "#fp";
import { t, withMessageGroups } from "#i18n";
import { logCaughtFailure } from "#shared/caught-failures.ts";
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import {
  registrationEmailDelivery,
  renderRegistrationEmailMessages,
  sendRegistrationEmails,
} from "#shared/email/registration.ts";
import { deliverDueRegistrationEmails } from "#shared/email/registration-work.ts";
import type { EmailEntry } from "#shared/email.ts";
import { fetchText, ResponseBodyTooLargeError } from "#shared/fetch.ts";
import { ErrorCode, logErrorLocal } from "#shared/logger.ts";
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
      logActivities([
        {
          message: t("admin.log.registration_delivery_failed"),
        },
      ]),
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
  entries: EmailEntry[],
  currency: string,
  packageFacts?: RegistrationPackageFacts,
  freeTexts?: FreeTextAnswers,
  emailDelivery?: Promise<RegistrationDeliveryResult>,
): Promise<void> => {
  const [webhookResult, emailResult] = await Promise.allSettled([
    sendRegistrationWebhooks(entries, currency, packageFacts),
    emailDelivery ??
      sendRegistrationEmails(entries, currency, packageFacts, freeTexts),
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

/** The package facts a notification needs, or the failure it must report:
 * one read shared by the direct queue and the durable one. */
const packageFactsOrReport = async (
  entries: EmailEntry[],
  supplied?: RegistrationPackageFacts,
): Promise<RegistrationPackageFacts | undefined> => {
  const needsPackageFacts =
    registrationWebhookUrls(entries).length > 0 ||
    registrationEmailDelivery(entries) !== null;
  return needsPackageFacts
    ? (supplied ?? (await loadRegistrationPackageFacts(entries)))
    : supplied;
};

/** Load the facts a notification needs, then run the queue call inside the
 * shared failure reporting: both queue paths use this one wrapper. */
const queueWithFacts = async (
  entries: EmailEntry[],
  supplied: RegistrationPackageFacts | undefined,
  queue: (
    packageFacts: RegistrationPackageFacts | undefined,
  ) => void | Promise<void>,
): Promise<void> => {
  let packageFacts: RegistrationPackageFacts | undefined;
  try {
    packageFacts = await packageFactsOrReport(entries, supplied);
    await queue(packageFacts);
  } catch (error) {
    await reportRegistrationDeliveryError();
    throw error;
  }
};

const queueRegistrationNotifications = (
  entries: EmailEntry[],
  currency: string,
  suppliedPackageFacts?: RegistrationPackageFacts,
  freeTexts?: FreeTextAnswers,
): Promise<void> =>
  queueWithFacts(entries, suppliedPackageFacts, (packageFacts) => {
    addPendingWork(
      sendRegistrationNotifications(entries, currency, packageFacts, freeTexts),
    );
  });

/** Queue a paid booking's registration emails durably: render them now from
 * the plaintext this request holds, seal them under the checkout work key,
 * and let the worker own delivery. A lost provider reply can resend. */
const queueDurableRegistration = (
  sessionId: string,
  entries: EmailEntry[],
  currency: string,
  options: NotifyRegistrationOptions,
): Promise<void> =>
  queueWithFacts(entries, options.packageFacts, async (packageFacts) => {
    const prepared = await renderRegistrationEmailMessages({
      currency,
      entries,
      freeTexts: options.freeTexts,
      suppliedFacts: packageFacts,
    });
    if (prepared !== null) {
      if (prepared.templateErrors.length > 0) {
        throw prepared.templateErrors[0]!;
      }
      // Await the durable rows before the drain starts, or the claim can
      // run ahead of the insert and find nothing due.
      await queueRegistrationEmails(
        sessionId,
        entries[0]!.attendee.id,
        prepared.messages,
      );
    }
    addPendingWork(
      sendRegistrationNotifications(
        entries,
        currency,
        packageFacts,
        undefined,
        deliverDueRegistrationEmails(),
      ),
    );
  });

/** Report background work that died after a booking was already paid for.
 * addPendingWork settles rejections silently, so without this the buyer keeps
 * the ticket and the operator never learns the site or its credit was lost. */
const reportAfterBookingFailure = (detail: string) =>
  logCaughtFailure(ErrorCode.SITE_ASSIGNMENT, detail);

/** What a booking passes to its notification queue. Everything is optional:
 * the plaintext free-text answers only the caller can hold, preloaded package
 * facts, extra activity-log lines, and the renewal token's hash. */
export interface NotifyRegistrationOptions {
  /** The buyer's typed free-text answers. The strings table keeps them sealed
   * to the owner key, which no notification path can spend, so the booking
   * request hands the plaintext it already holds to the confirmation email. */
  freeTexts?: FreeTextAnswers | undefined;
  /** Package facts the caller already loaded, so the queue does not re-read
   * them. */
  packageFacts?: RegistrationPackageFacts | undefined;
  /** Activity-log lines recorded beside the registration lines. */
  priorActivities?: readonly ActivityToLog[] | undefined;
  /** The paid checkout's session id. Present only when the booking's emails
   * must survive the request: they queue durably keyed by this session, and a
   * replay never sends them twice. */
  sessionId?: string | undefined;
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
  addPendingWork(
    options.sessionId === undefined
      ? queueRegistrationNotifications(
          entries,
          currency,
          options.packageFacts,
          options.freeTexts,
        )
      : queueDurableRegistration(options.sessionId, entries, currency, options),
  );
  addPendingWork(
    assignAndNotifyBuiltSites(entries).catch(
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
