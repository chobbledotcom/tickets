import { flatMap, mapNotNullish, unique } from "#fp";
import { type ActivityToLog, logActivities } from "#shared/db/activity-log.ts";
import { settings } from "#shared/db/settings.ts";
import {
  registrationEmailDelivery,
  sendRegistrationEmails,
} from "#shared/email/registration.ts";
import type { EmailEntry } from "#shared/email.ts";
import { fetchText, ResponseBodyTooLargeError } from "#shared/fetch.ts";
import { t, withMessageGroups } from "#shared/i18n.ts";
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

export const sendRegistrationNotifications = async (
  entries: EmailEntry[],
  currency: string,
  packageFacts?: RegistrationPackageFacts,
): Promise<void> => {
  const [webhookResult, emailResult] = await Promise.allSettled([
    sendRegistrationWebhooks(entries, currency, packageFacts),
    sendRegistrationEmails(entries, currency, packageFacts),
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
  entries: EmailEntry[],
  currency: string,
  suppliedPackageFacts?: RegistrationPackageFacts,
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
    await reportRegistrationDeliveryError();
    throw error;
  }
  addPendingWork(
    sendRegistrationNotifications(entries, currency, packageFacts),
  );
};

/** Record a registration and queue its external notifications. */
export const logAndNotifyRegistration = async (
  entries: EmailEntry[],
  siteTokenIndex?: string,
  priorActivities: readonly ActivityToLog[] = [],
  suppliedPackageFacts?: RegistrationPackageFacts,
): Promise<void> => {
  await logActivities([
    ...priorActivities,
    ...entries.map(({ listing, attendee }) => ({
      attendeeId: attendee.id,
      listing,
      message: `Attendee registered for '${listing.name}'`,
    })),
  ]);
  const currency = settings.currency;
  addPendingWork(
    queueRegistrationNotifications(entries, currency, suppliedPackageFacts),
  );
  addPendingWork(assignAndNotifyBuiltSites(entries));
  addPendingWork(applyRenewalsForEntries(entries, siteTokenIndex));
};
