/**
 * Payment Provider, Stripe, Square, and Booking Fee forms for settings
 */

import { MASK_SENTINEL } from "#shared/db/settings.ts";
import { CsrfForm, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import {
  squareAccessTokenFields,
  squareWebhookFields,
  stripeKeyFields,
  sumupFields,
} from "#templates/fields.ts";

export const PaymentProviderForm = (s: SettingsPageState): JSX.Element => (
  <CsrfForm
    action="/admin/settings/payment-provider"
    id="settings-payment-provider"
  >
    <h2>Payment Provider</h2>
    <p>Choose which payment provider to use for paid listings.</p>
    <fieldset class="radio-group">
      <label>
        <input
          checked={!s.paymentProvider}
          name="payment_provider"
          type="radio"
          value="none"
        />
        None (payments disabled)
      </label>
      <label>
        <input
          checked={s.paymentProvider === "stripe"}
          name="payment_provider"
          type="radio"
          value="stripe"
        />
        Stripe
      </label>
      <label>
        <input
          checked={s.paymentProvider === "square"}
          name="payment_provider"
          type="radio"
          value="square"
        />
        Square
      </label>
      <label>
        <input
          checked={s.paymentProvider === "sumup"}
          name="payment_provider"
          type="radio"
          value="sumup"
        />
        SumUp
      </label>
    </fieldset>
    <button type="submit">Save Payment Provider</button>
  </CsrfForm>
);

/** Test/live mode notice for providers that use sk_test_/sk_live_ keys
 * (Stripe and SumUp). Renders nothing when the mode is unknown. */
const ApiKeyModeNotice = ({
  mode,
  provider,
}: {
  mode: string | null;
  provider: string;
}): JSX.Element | null => {
  if (mode === "test") {
    return (
      <p class="notice warning">
        <strong>Test mode:</strong> You are using a {provider} test key (
        <code>sk_test_</code>). No real charges will be made. Switch to a live
        key (<code>sk_live_</code>) when you are ready to accept real payments.
      </p>
    );
  }
  if (mode === "live") {
    return (
      <p class="notice">
        <strong>Live mode:</strong> You are using a {provider} live key.
        Payments will be charged for real.
      </p>
    );
  }
  return null;
};

export const StripeForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider === "stripe" ? (
    <CsrfForm action="/admin/settings/stripe" id="settings-stripe">
      <h2>Stripe Settings</h2>
      <p>
        {s.stripeKeyConfigured
          ? "A Stripe secret key is currently configured. Enter a new key below to replace it."
          : "No Stripe key is configured. Enter your Stripe secret key to enable Stripe payments."}
      </p>
      {s.stripeKeyConfigured && (
        <ApiKeyModeNotice mode={s.stripeKeyMode} provider="Stripe" />
      )}
      <p>
        <small>
          <a href="/admin/guide#payment-setup">Where do I find this?</a>
        </small>
      </p>
      <Raw
        html={renderFields(
          stripeKeyFields,
          s.stripeKeyConfigured ? { stripe_secret_key: MASK_SENTINEL } : {},
        )}
      />
      <footer>
        <button type="submit">Update Stripe Key</button>
        {s.stripeKeyConfigured && (
          <button class="secondary" id="stripe-test-btn" type="button">
            Test Connection
          </button>
        )}
      </footer>
      <div class="hidden" id="stripe-test-result"></div>
    </CsrfForm>
  ) : null;

export const SquareForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider === "square" ? (
    <CsrfForm action="/admin/settings/square" id="settings-square">
      <h2>Square Settings</h2>
      <p>
        {s.squareTokenConfigured
          ? "A Square access token is currently configured. Enter new credentials below to replace them."
          : "No Square access token is configured. Enter your Square credentials to enable Square payments."}
      </p>
      <p>
        <small>
          <a href="/admin/guide#payment-setup">Where do I find these?</a>
        </small>
      </p>
      <Raw
        html={renderFields(
          squareAccessTokenFields,
          s.squareTokenConfigured ? { square_access_token: MASK_SENTINEL } : {},
        )}
      />
      <label>
        <input
          checked={s.squareSandbox}
          name="square_sandbox"
          type="checkbox"
        />
        Sandbox mode (use Square's test environment)
      </label>
      <footer>
        <button type="submit">Update Square Credentials</button>
        {s.squareTokenConfigured && (
          <button class="secondary" id="square-test-btn" type="button">
            Test Connection
          </button>
        )}
      </footer>
      <div class="hidden" id="square-test-result"></div>
    </CsrfForm>
  ) : null;

export const SquareWebhookForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider === "square" && s.squareTokenConfigured ? (
    <CsrfForm
      action="/admin/settings/square-webhook"
      id="settings-square-webhook"
    >
      <h2>Square Webhook</h2>
      <p>
        <a href="/admin/guide#payment-setup">See the full setup guide</a>
      </p>
      <article>
        <aside>
          <p>
            To receive payment notifications, set up a webhook in your Square
            Developer Dashboard:
          </p>
          <ol>
            <li>
              Go to your <strong>Square Developer Dashboard</strong> and select
              your application
            </li>
            <li>
              Navigate to <strong>Webhooks</strong> in the left sidebar
            </li>
            <li>
              Click <strong>Add Subscription</strong>
            </li>
            <li>
              Set the <strong>Notification URL</strong> to:
              <br />
              <code>{s.webhookUrl}</code>
            </li>
            <li>
              Subscribe to the <strong>payment.updated</strong> listing
            </li>
            <li>
              Save the subscription and copy the <strong>Signature Key</strong>
            </li>
            <li>Paste the signature key below</li>
          </ol>
        </aside>
      </article>
      <p>
        {s.squareWebhookConfigured
          ? "A webhook signature key is currently configured. Enter a new key below to replace it."
          : "No webhook signature key is configured. Follow the steps above to set one up."}
      </p>
      <Raw
        html={renderFields(
          squareWebhookFields,
          s.squareWebhookConfigured
            ? { square_webhook_signature_key: MASK_SENTINEL }
            : {},
        )}
      />
      <button type="submit">Update Webhook Key</button>
    </CsrfForm>
  ) : null;

export const SumUpForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider === "sumup" ? (
    <CsrfForm action="/admin/settings/sumup" id="settings-sumup">
      <h2>SumUp Settings</h2>
      <p>
        {s.sumupKeyConfigured
          ? "A SumUp API key is currently configured. Enter new credentials below to replace them."
          : "No SumUp API key is configured. Enter your SumUp credentials to enable SumUp payments."}
      </p>
      {s.sumupKeyConfigured && (
        <ApiKeyModeNotice mode={s.sumupKeyMode} provider="SumUp" />
      )}
      <p>
        <small>
          <a href="/admin/guide#payment-setup">Where do I find these?</a>
        </small>
      </p>
      <Raw
        html={renderFields(
          sumupFields,
          s.sumupKeyConfigured ? { sumup_api_key: MASK_SENTINEL } : {},
        )}
      />
      <footer>
        <button type="submit">Update SumUp Credentials</button>
        {s.sumupKeyConfigured && (
          <button class="secondary" id="sumup-test-btn" type="button">
            Test Connection
          </button>
        )}
      </footer>
      <div class="hidden" id="sumup-test-result"></div>
    </CsrfForm>
  ) : null;

export const BookingFeeForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider ? (
    <CsrfForm action="/admin/settings/booking-fee" id="settings-booking-fee">
      <h2>Booking Fee</h2>
      <p>
        Percentage fee added at checkout (e.g. 1.5 for 1.5%). Set to 0 to
        disable. Max 10.
      </p>
      <label>
        Booking Fee (%)
        <input
          max="10"
          min="0"
          name="booking_fee"
          required
          step="0.1"
          type="number"
          value={s.bookingFee}
        />
      </label>
      <button type="submit">Save Booking Fee</button>
    </CsrfForm>
  ) : null;
