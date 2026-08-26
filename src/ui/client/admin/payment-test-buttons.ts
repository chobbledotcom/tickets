/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { csrfPost } from "./csrf.ts";

/** Show the result box with the given text, coloured green for a pass and red
 * for a failure. */
const showTestResult = (
  resultDiv: HTMLElement,
  text: string,
  passed: boolean,
  cssClass: string,
) => {
  resultDiv.textContent = text;
  resultDiv.classList.remove("hidden", "success", "error");
  resultDiv.classList.add(passed ? "success" : "error", cssClass);
};

/** Wire up one payment provider's "Test Connection" button. The provider's
 * own name gives the two element ids, the result class and the test address,
 * so the page and this script cannot disagree about any of them. */
const setupTestButton = (
  provider: string,
  // deno-lint-ignore no-explicit-any
  formatLines: (data: any) => string[],
) => {
  const button = document.getElementById(`${provider}-test-btn`);
  if (!(button instanceof HTMLButtonElement)) return;
  const resultId = `${provider}-test-result`;
  // The page owns the button label, so keep its own words to put back.
  const label = button.textContent;
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
      const data = await csrfPost(
        `/admin/settings/${provider}/test`,
        csrfInput?.value ?? "",
      );
      showTestResult(
        resultDiv,
        formatLines(data).join("\n"),
        data.ok,
        resultId,
      );
    } catch (e) {
      showTestResult(
        resultDiv,
        `Connection test failed: ${e instanceof Error ? e.message : "Unknown error"}`,
        false,
        resultId,
      );
    }
    button.disabled = false;
    button.textContent = label;
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

/** Wire up the "Test Connection" button of every payment provider that has
 * one on the admin settings page. */
export const initPaymentTestButtons = (): void => {
  setupTestButton("stripe", (data) => [
    formatCredentialLine("API Key", data.apiKey),
    ...formatStripeWebhooks(data),
  ]);

  setupTestButton("square", (data) => [
    formatCredentialLine("Access Token", data.accessToken),
    formatLocationLine(data.location),
    formatWebhookLine(data.webhook, "Signature key configured"),
  ]);

  setupTestButton("sumup", (data) => {
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
  });
};
