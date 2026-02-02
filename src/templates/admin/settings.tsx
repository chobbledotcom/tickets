/**
 * Admin settings page template
 */

import { renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession } from "#lib/types.ts";
import {
  changePasswordFields,
  squareAccessTokenFields,
  squareWebhookFields,
  stripeKeyFields,
} from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

/**
 * Admin settings page
 */
export const adminSettingsPage = (
  session: AdminSession,
  stripeKeyConfigured: boolean,
  paymentProvider: string | null,
  error?: string,
  success?: string,
  squareTokenConfigured?: boolean,
  squareWebhookConfigured?: boolean,
  webhookUrl?: string,
): string =>
  String(
    <Layout title="Settings">
      <AdminNav session={session} />

      {error && <div class="error">{error}</div>}
      {success && <div class="success">{success}</div>}

        <form method="POST" action="/admin/settings/payment-provider">
            <h2>Payment Provider</h2>
          <p>Choose which payment provider to use for paid events.</p>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
          <fieldset>
            <label>
              <input
                type="radio"
                name="payment_provider"
                value="none"
                checked={!paymentProvider}
              />
              None (payments disabled)
            </label>
            <label>
              <input
                type="radio"
                name="payment_provider"
                value="stripe"
                checked={paymentProvider === "stripe"}
              />
              Stripe
            </label>
            <label>
              <input
                type="radio"
                name="payment_provider"
                value="square"
                checked={paymentProvider === "square"}
              />
              Square
            </label>
          </fieldset>
          <button type="submit">Save Payment Provider</button>
        </form>

        {paymentProvider === "stripe" && (
        <form method="POST" action="/admin/settings/stripe">
            <h2>Stripe Settings</h2>
          <p>
            {stripeKeyConfigured
              ? "A Stripe secret key is currently configured. Enter a new key below to replace it."
              : "No Stripe key is configured. Enter your Stripe secret key to enable Stripe payments."}
          </p>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
          <Raw html={renderFields(stripeKeyFields)} />
          <button type="submit">Update Stripe Key</button>
          {stripeKeyConfigured && (
            <button type="button" id="stripe-test-btn" class="secondary">Test Connection</button>
          )}
          <div id="stripe-test-result" style="display:none"></div>
        </form>
        )}

        {stripeKeyConfigured && paymentProvider === "stripe" && (
          <Raw html={`<script>
document.getElementById('stripe-test-btn')?.addEventListener('click', async function() {
  var btn = this;
  var resultDiv = document.getElementById('stripe-test-result');
  btn.disabled = true;
  btn.textContent = 'Testing...';
  resultDiv.style.display = 'none';
  resultDiv.className = '';
  try {
    var csrfToken = btn.closest('form').querySelector('input[name="csrf_token"]').value;
    var res = await fetch('/admin/settings/stripe/test', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf_token=' + encodeURIComponent(csrfToken) });
    var data = await res.json();
    var lines = [];
    if (data.apiKey.valid) {
      lines.push('API Key: Valid (' + data.apiKey.mode + ' mode)');
    } else {
      lines.push('API Key: Invalid' + (data.apiKey.error ? ' - ' + data.apiKey.error : ''));
    }
    if (data.webhook.configured) {
      lines.push('Webhook: ' + (data.webhook.status || 'configured'));
      lines.push('URL: ' + data.webhook.url);
      if (data.webhook.enabledEvents) {
        lines.push('Events: ' + data.webhook.enabledEvents.join(', '));
      }
    } else {
      lines.push('Webhook: Not configured' + (data.webhook.error ? ' - ' + data.webhook.error : ''));
    }
    resultDiv.textContent = lines.join('\\n');
    resultDiv.className = data.ok ? 'success' : 'error';
    resultDiv.style.display = 'block';
    resultDiv.style.whiteSpace = 'pre-wrap';
  } catch (e) {
    resultDiv.textContent = 'Connection test failed: ' + e.message;
    resultDiv.className = 'error';
    resultDiv.style.display = 'block';
  }
  btn.disabled = false;
  btn.textContent = 'Test Connection';
});
</script>`} />
        )}

        {paymentProvider === "square" && (
        <form method="POST" action="/admin/settings/square">
            <h2>Square Settings</h2>
          <p>
            {squareTokenConfigured
              ? "A Square access token is currently configured. Enter new credentials below to replace them."
              : "No Square access token is configured. Enter your Square credentials to enable Square payments."}
          </p>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
          <Raw html={renderFields(squareAccessTokenFields)} />
          <button type="submit">Update Square Credentials</button>
        </form>
        )}

        {paymentProvider === "square" && squareTokenConfigured && (
        <form method="POST" action="/admin/settings/square-webhook">
            <h2>Square Webhook</h2>
          <article>
            <aside>
              <p>To receive payment notifications, set up a webhook in your Square Developer Dashboard:</p>
              <ol>
                <li>Go to your <strong>Square Developer Dashboard</strong> and select your application</li>
                <li>Navigate to <strong>Webhooks</strong> in the left sidebar</li>
                <li>Click <strong>Add Subscription</strong></li>
                <li>Set the <strong>Notification URL</strong> to:<br /><code>{webhookUrl ?? "(configure ALLOWED_DOMAIN first)"}</code></li>
                <li>Subscribe to the <strong>payment.updated</strong> event</li>
                <li>Save the subscription and copy the <strong>Signature Key</strong></li>
                <li>Paste the signature key below</li>
              </ol>
            </aside>
          </article>
          <p>
            {squareWebhookConfigured
              ? "A webhook signature key is currently configured. Enter a new key below to replace it."
              : "No webhook signature key is configured. Follow the steps above to set one up."}
          </p>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
          <Raw html={renderFields(squareWebhookFields)} />
          <button type="submit">Update Webhook Key</button>
        </form>
        )}

        <form method="POST" action="/admin/settings">
            <h2>Change Password</h2>
          <p>Changing your password will log you out of all sessions.</p>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
          <Raw html={renderFields(changePasswordFields)} />
          <button type="submit">Change Password</button>
        </form>

        <form method="POST" action="/admin/settings/reset-database">
            <h2>Reset Database</h2>
          <article>
            <aside>
              <p><strong>Warning:</strong> This will permanently delete all events, attendees, settings, and other data. This action cannot be undone.</p>
            </aside>
          </article>
          <p>To reset the database, type the following phrase into the box below:</p>
          <p><strong>"The site will be fully reset and all data will be lost."</strong></p>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
          <label for="confirm_phrase">Confirmation phrase</label>
          <input
            type="text"
            id="confirm_phrase"
            name="confirm_phrase"
            autocomplete="off"
            required
          />
          <button type="submit" class="danger">
            Reset Database
          </button>
        </form>
    </Layout>
  );
