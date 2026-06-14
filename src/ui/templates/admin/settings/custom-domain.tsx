/**
 * Custom Domain form for advanced settings
 */

import { CsrfForm } from "#shared/forms.tsx";
import { DomainPaymentWebhookWarning } from "#templates/admin/settings/domain-payment-warning.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";

export const CustomDomainForm = (
  s: AdvancedSettingsPageState,
): JSX.Element | null =>
  s.bunnyCdnEnabled ? (
    <div class="stack stack-sm">
      <CsrfForm
        action="/admin/settings/custom-domain"
        id="settings-custom-domain"
      >
        <h2>Custom Domain</h2>
        <p>
          Set a custom domain for your tickets site.{" "}
          <a href="/admin/guide#custom-domain">Setup guide</a>.
          {s.bunnySubdomain &&
            " Your host subdomain can be active at the same time as a custom domain."}
        </p>
        <label>
          Domain
          <input
            autocomplete="off"
            name="custom_domain"
            placeholder="tickets.yourdomain.com"
            type="text"
            value={s.customDomain}
          />
        </label>
        <SubmitButton icon="save">Save Custom Domain</SubmitButton>
        <DomainPaymentWebhookWarning paymentProvider={s.paymentProvider} />
      </CsrfForm>

      {s.customDomain && (
        <CsrfForm
          action="/admin/settings/custom-domain/validate"
          id="settings-custom-domain-validate"
        >
          {!s.customDomainLastValidated && (
            <article>
              <aside role="alert">
                <p>
                  <strong>Your custom domain is not yet validated.</strong> It
                  will not work until validation is complete.
                </p>
              </aside>
            </article>
          )}
          <article>
            <aside>
              <p>
                To use your custom domain, create a <strong>CNAME</strong>{" "}
                record:
              </p>
              <ul>
                <li>
                  <strong>Type:</strong> CNAME
                </li>
                <li>
                  <strong>Name:</strong> <code>{s.customDomain}</code>
                </li>
                <li>
                  <strong>Value:</strong> <code>{s.cdnHostname}</code>
                </li>
                <li>
                  <strong>TTL:</strong> 3600
                </li>
              </ul>
              <p>
                Once the DNS record is in place, click the button below to
                validate and enable SSL.
              </p>
            </aside>
          </article>
          {s.customDomainLastValidated && (
            <p>
              <small>Last validated: {s.customDomainLastValidated}</small>
            </p>
          )}
          <SubmitButton icon="check">Validate Custom Domain</SubmitButton>
        </CsrfForm>
      )}
    </div>
  ) : null;
