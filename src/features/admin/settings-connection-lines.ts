/**
 * The answer lines a payment provider's "Test connection" button shows,
 * rendered from the message catalog. The nightly payment e2e derives its
 * expected lines from the same keys, so a wording change cannot pass review
 * on one side and break the schedule-only run on the other.
 */
import { t } from "#i18n";
import type { CredentialCheck } from "#shared/payment-helpers.ts";
import type { SquareConnectionTestResult } from "#shared/square/connection.ts";
import type {
  StripeConnectionTestResult,
  WebhookEndpointStatus,
} from "#shared/stripe/endpoints.ts";
import type { SumupConnectionTestResult } from "#shared/sumup.ts";

/** What the connection-test button shows for one provider. */
export interface ConnectionAnswer {
  readonly lines: readonly string[];
  readonly ok: boolean;
}

/** The line naming what a configured item carries. */
const valueLine = (labelKey: string, value: string): string =>
  t("settings.connection.value", { label: t(labelKey), value });

/** The line for an item that is not configured, naming why when it knows. */
const missingLine = (labelKey: string, error: string | undefined): string =>
  error === undefined
    ? t("settings.connection.not_configured", { label: t(labelKey) })
    : t("settings.connection.not_configured_with_error", {
        error,
        label: t(labelKey),
      });

/** The line one credential renders: valid (with its mode), or why not. */
const credentialLine = (label: string, cred: CredentialCheck): string =>
  cred.valid
    ? t("settings.connection.valid", { label, mode: cred.mode ?? "unknown" })
    : cred.error === undefined
      ? t("settings.connection.invalid", { label })
      : t("settings.connection.invalid_with_error", {
          error: cred.error,
          label,
        });

/** One webhook endpoint: its state line, marked when we created it, plus
 * the events it listens for. */
const endpointLine = (
  endpoint: WebhookEndpointStatus,
  ownId: string | null | undefined,
): readonly string[] => {
  const described = t("settings.connection.endpoint", {
    status: endpoint.status,
    url: endpoint.url,
  });
  const marked =
    endpoint.endpointId === ownId
      ? `${described} ${t("settings.connection.own_endpoint")}`
      : described;
  return [
    `  ${marked}`,
    `  ${t("settings.connection.events", {
      events: endpoint.enabledEvents.join(", "),
    })}`,
  ];
};

/** Stripe's answer: the key first, then the webhook estate it found. */
export const stripeConnectionAnswer = (
  result: StripeConnectionTestResult,
): ConnectionAnswer => ({
  lines: [
    credentialLine(t("settings.connection.label_api_key"), result.apiKey),
    ...(result.webhookError !== undefined
      ? [
          t("settings.connection.webhooks_error", {
            error: result.webhookError,
          }),
        ]
      : result.webhooks.length === 0
        ? [t("settings.connection.webhooks_none")]
        : [
            t("settings.connection.webhooks_count", {
              count: String(result.webhooks.length),
            }),
            ...result.webhooks.flatMap((endpoint) =>
              endpointLine(endpoint, result.ownEndpointId),
            ),
          ]),
  ],
  ok: result.ok,
});

/** Square's answer: the token, the chosen place, and the webhook key. */
export const squareConnectionAnswer = (
  result: SquareConnectionTestResult,
): ConnectionAnswer => ({
  lines: [
    credentialLine(
      t("settings.connection.label_access_token"),
      result.accessToken,
    ),
    result.location.configured
      ? `${valueLine(
          "settings.connection.label_location",
          `${result.location.name || result.location.locationId}`,
        )}${result.location.status === undefined ? "" : ` (${result.location.status})`}`
      : missingLine(
          "settings.connection.label_location",
          result.location.error,
        ),
    result.webhook.configured
      ? valueLine(
          "settings.connection.label_webhook",
          t("settings.connection.signature_configured"),
        )
      : missingLine("settings.connection.label_webhook", result.webhook.error),
  ],
  ok: result.ok,
});

/** SumUp's answer: the key, the merchant behind it, and the currency. */
export const sumupConnectionAnswer = (
  result: SumupConnectionTestResult,
): ConnectionAnswer => {
  const keyLine = credentialLine(
    t("settings.connection.label_api_key"),
    result.apiKey,
  );
  // A rejected key means the merchant lookup never ran, so a "Merchant: Not
  // configured" line would mislead; the key line already carries the fix.
  if (!result.apiKey.valid) return { lines: [keyLine], ok: result.ok };
  return {
    lines: [
      keyLine,
      result.merchant.configured
        ? valueLine(
            "settings.connection.label_merchant",
            `${result.merchant.merchantCode}`,
          )
        : missingLine(
            "settings.connection.label_merchant",
            result.merchant.error,
          ),
      result.currency.supported
        ? t("settings.connection.currency_supported", {
            code: result.currency.code,
          })
        : t("settings.connection.currency_unsupported", {
            code: result.currency.code,
          }),
    ],
    ok: result.ok,
  };
};
