/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { csrfPost } from "./csrf.ts";

/** Wire up a payment provider "Test Connection" button.
 * @param btnId - button element ID
 * @param resultId - result div element ID
 * @param url - POST endpoint to test
 * @param cssClass - CSS class for result formatting
 * @param formatLines - extract display lines from JSON response
 */
const setupTestButton = (
  btnId: string,
  resultId: string,
  url: string,
  cssClass: string,
  // deno-lint-ignore no-explicit-any
  formatLines: (data: any) => string[],
) => {
  const button = document.getElementById(btnId);
  if (!(button instanceof HTMLButtonElement)) return;
  button.addEventListener("click", async () => {
    const resultDiv = document.getElementById(resultId)!;
    button.disabled = true;
    button.textContent = "Testing...";
    resultDiv.classList.add("hidden");
    resultDiv.classList.remove("success", "error");
    try {
      const csrfInput = button
        .closest("form")
        ?.querySelector<HTMLInputElement>('input[name="csrf_token"]');
      const data = await csrfPost(url, csrfInput?.value ?? "");
      resultDiv.textContent = formatLines(data).join("\n");
      resultDiv.classList.remove("hidden", "success", "error");
      resultDiv.classList.add(data.ok ? "success" : "error", cssClass);
    } catch (e) {
      resultDiv.textContent = `Connection test failed: ${e instanceof Error ? e.message : "Unknown error"}`;
      resultDiv.classList.remove("hidden", "success", "error");
      resultDiv.classList.add("error", cssClass);
    }
    button.disabled = false;
    button.textContent = "Test Connection";
  });
};

/** Format a webhook status line from a test result's webhook field */
// deno-lint-ignore no-explicit-any
const formatWebhookLine = (webhook: any, detail?: string): string =>
  webhook.configured
    ? `Webhook: ${detail ?? "configured"}`
    : `Webhook: Not configured${webhook.error ? ` - ${webhook.error}` : ""}`;

/** Format a Square location line */
// deno-lint-ignore no-explicit-any
const formatLocationLine = (loc: any): string =>
  loc.configured
    ? `Location: ${loc.name ?? loc.locationId}${loc.status ? ` (${loc.status})` : ""}`
    : `Location: Not configured${loc.error ? ` - ${loc.error}` : ""}`;

/** Format a credential validity line (e.g. "API Key: Valid (test mode)") */
// deno-lint-ignore no-explicit-any
const formatCredentialLine = (label: string, cred: any): string =>
  cred.valid
    ? `${label}: Valid (${cred.mode} mode)`
    : `${label}: Invalid${cred.error ? ` - ${cred.error}` : ""}`;

/** Format Stripe webhook endpoint lines */
// deno-lint-ignore no-explicit-any
const formatStripeWebhooks = (data: any): string[] => {
  if (data.webhookError) return [`Webhooks: Error - ${data.webhookError}`];
  if (!data.webhooks?.length) return ["Webhooks: None configured"];
  const lines = [`Webhooks: ${data.webhooks.length} endpoint(s)`];
  for (const wh of data.webhooks) {
    const ours =
      data.ownEndpointId && wh.endpointId === data.ownEndpointId
        ? " (tickets)"
        : "";
    lines.push(`  ${wh.status} - ${wh.url}${ours}`);
    lines.push(`  Events: ${wh.enabledEvents.join(", ")}`);
  }
  return lines;
};

/** Wire up Stripe + Square "Test Connection" buttons on the admin settings page. */
export const initPaymentTestButtons = (): void => {
  setupTestButton(
    "stripe-test-btn",
    "stripe-test-result",
    "/admin/settings/stripe/test",
    "stripe-test-result",
    (data) => [
      formatCredentialLine("API Key", data.apiKey),
      ...formatStripeWebhooks(data),
    ],
  );

  setupTestButton(
    "square-test-btn",
    "square-test-result",
    "/admin/settings/square/test",
    "square-test-result",
    (data) => [
      formatCredentialLine("Access Token", data.accessToken),
      formatLocationLine(data.location),
      formatWebhookLine(data.webhook, "Signature key configured"),
    ],
  );

  setupTestButton(
    "sumup-test-btn",
    "sumup-test-result",
    "/admin/settings/sumup/test",
    "sumup-test-result",
    (data) => {
      const apiKeyLine = formatCredentialLine("API Key", data.apiKey);
      // A rejected key means the merchant lookup never ran, so "Merchant: Not
      // configured" would be misleading and the currency note is just noise.
      // The API Key line already carries the full, actionable fix.
      if (!data.apiKey.valid) return [apiKeyLine];
      return [
        apiKeyLine,
        data.merchant.configured
          ? `Merchant: ${data.merchant.merchantCode}`
          : `Merchant: Not configured${data.merchant.error ? ` - ${data.merchant.error}` : ""}`,
        data.currency.supported
          ? `Currency: ${data.currency.code} (supported)`
          : `Currency: ${data.currency.code} is not supported by SumUp`,
      ];
    },
  );
};
