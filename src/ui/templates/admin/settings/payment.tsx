/**
 * Payment Provider, Stripe, Square, and Booking Fee forms for settings
 */

import { t } from "#i18n";
import { MASK_SENTINEL } from "#shared/db/settings.ts";
import { CsrfForm, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  PAYMENT_PROVIDER_IDS,
  PAYMENT_PROVIDERS,
} from "#shared/payment-providers.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { RadioOption } from "#templates/components/radio-option.tsx";
import {
  getSquareAccessTokenFields,
  getSquareWebhookFields,
  getStripeKeyFields,
  getSumupFields,
} from "#templates/fields.ts";

export const PaymentProviderForm = (s: SettingsPageState): JSX.Element => (
  <CsrfForm
    action="/admin/settings/payment-provider"
    id="settings-payment-provider"
  >
    <div class="prose">
      <h2>{t("settings.payment_provider")}</h2>
      <p>{t("settings.payment_provider_hint")}</p>
    </div>
    <fieldset class="radios">
      <RadioOption
        checked={!s.paymentProvider}
        name="payment_provider"
        value="none"
      >
        {t("settings.payment_none")}
      </RadioOption>
      {PAYMENT_PROVIDER_IDS.map((id) => (
        <RadioOption
          checked={s.paymentProvider === id}
          name="payment_provider"
          value={id}
        >
          {PAYMENT_PROVIDERS[id].label}
        </RadioOption>
      ))}
    </fieldset>
    <SubmitButton icon="save">
      {t("settings.save_payment_provider")}
    </SubmitButton>
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

/** The save/Test Connection footer plus its hidden result div, shared by the
 *  Stripe and SumUp key forms. Curried by the provider's id-slug, the
 *  "Update <provider> Credentials" label, and the "Test Connection" label. */
const paymentTestFooter = (
  provider: string,
  keyConfigured: boolean,
  updateLabel: string,
  testConnectionLabel: string,
): JSX.Element => (
  <>
    <footer>
      <SubmitButton icon="save">{updateLabel}</SubmitButton>
      {keyConfigured && (
        <button class="secondary" id={`${provider}-test-btn`} type="button">
          {testConnectionLabel}
        </button>
      )}
    </footer>
    <div class="hidden" id={`${provider}-test-result`} />
  </>
);

export const StripeForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider === "stripe" ? (
    <CsrfForm action="/admin/settings/stripe" id="settings-stripe">
      <div class="prose">
        <h2>{t("settings.stripe.heading")}</h2>
        <p>
          {s.stripeKeyConfigured
            ? t("settings.stripe.configured_hint")
            : t("settings.stripe.not_configured_hint")}
        </p>
      </div>
      {s.stripeKeyConfigured && (
        <ApiKeyModeNotice mode={s.stripeKeyMode} provider="Stripe" />
      )}
      <p>
        <small>
          <a href="/admin/guide#payment-setup">
            {t("settings.stripe.where_to_find")}
          </a>
        </small>
      </p>
      <Raw
        html={renderFields(
          getStripeKeyFields(),
          s.stripeKeyConfigured ? { stripe_secret_key: MASK_SENTINEL } : {},
        )}
      />
      {paymentTestFooter(
        "stripe",
        s.stripeKeyConfigured,
        t("settings.stripe.update_key"),
        t("settings.stripe.test_connection"),
      )}
    </CsrfForm>
  ) : null;

export const SquareForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider === "square" ? (
    <CsrfForm action="/admin/settings/square" id="settings-square">
      <div class="prose">
        <h2>{t("settings.square.heading")}</h2>
        <p>
          {s.squareTokenConfigured
            ? t("settings.square.configured_hint")
            : t("settings.square.not_configured_hint")}
        </p>
        <p>
          <small>
            <a href="/admin/guide#payment-setup">
              {t("settings.square.where_to_find")}
            </a>
          </small>
        </p>
      </div>
      <Raw
        html={renderFields(
          getSquareAccessTokenFields(),
          s.squareTokenConfigured ? { square_access_token: MASK_SENTINEL } : {},
        )}
      />
      <label>
        <input
          checked={s.squareSandbox}
          name="square_sandbox"
          type="checkbox"
        />
        {t("settings.square.sandbox_mode")}
      </label>
      <footer>
        <SubmitButton icon="save">
          {t("settings.square.update_credentials")}
        </SubmitButton>
        {s.squareTokenConfigured && (
          <button class="secondary" id="square-test-btn" type="button">
            {t("settings.square.test_connection")}
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
      <div class="prose">
        <h2>{t("settings.square.webhook_heading")}</h2>
        <p>
          <a href="/admin/guide#payment-setup">
            {t("settings.square.webhook_guide_link")}
          </a>
        </p>
      </div>
      <article>
        <aside>
          <p>{t("settings.square.webhook_instructions")}</p>
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
              Subscribe to the <strong>payment.updated</strong> event
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
          ? t("settings.square.webhook_configured_hint")
          : t("settings.square.webhook_not_configured_hint")}
      </p>
      <Raw
        html={renderFields(
          getSquareWebhookFields(),
          s.squareWebhookConfigured
            ? { square_webhook_signature_key: MASK_SENTINEL }
            : {},
        )}
      />
      <SubmitButton icon="save">
        {t("settings.square.update_webhook_key")}
      </SubmitButton>
    </CsrfForm>
  ) : null;

export const SumUpForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider === "sumup" ? (
    <CsrfForm action="/admin/settings/sumup" id="settings-sumup">
      <div class="prose">
        <h2>{t("settings.sumup.heading")}</h2>
        <p>
          {s.sumupKeyConfigured
            ? "A SumUp API key is currently configured. Enter new credentials below to replace them."
            : "No SumUp API key is configured. Enter your SumUp credentials to enable SumUp payments."}
        </p>
      </div>
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
          getSumupFields(),
          s.sumupKeyConfigured ? { sumup_api_key: MASK_SENTINEL } : {},
        )}
      />
      {paymentTestFooter(
        "sumup",
        s.sumupKeyConfigured,
        "Update SumUp Credentials",
        "Test Connection",
      )}
    </CsrfForm>
  ) : null;

export const BookingFeeForm = (s: SettingsPageState): JSX.Element | null =>
  s.paymentProvider ? (
    <CsrfForm action="/admin/settings/booking-fee" id="settings-booking-fee">
      <div class="prose">
        <h2>{t("settings.booking_fee")}</h2>
        <p>{t("settings.booking_fee_hint")}</p>
      </div>
      <label>
        {t("settings.booking_fee_label")}
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
      <SubmitButton icon="save">{t("settings.save_booking_fee")}</SubmitButton>
    </CsrfForm>
  ) : null;
