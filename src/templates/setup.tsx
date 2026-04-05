/**
 * Setup page templates - initial configuration
 */

import { COUNTRIES, DEFAULT_COUNTRY } from "#lib/countries.ts";
import { CsrfForm, Flash, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { setupFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Data Controller Agreement - displayed during setup
 * Users must accept these terms to complete setup
 */
const DataControllerAgreement = (): JSX.Element => (
  <fieldset class="agreement">
    <legend>Data Controller Agreement</legend>
    <p>By completing setup, you confirm:</p>
    <ol>
      <li>
        <strong>You are the data controller</strong> - You decide what data to
        collect and are responsible for your own GDPR/data protection compliance
      </li>
      <li>
        <strong>We are a data processor</strong> - We store your encrypted data
        but cannot access attendee information without your admin password
      </li>
      <li>
        <strong>Your data is encrypted</strong> - Attendee names, emails, and
        payment references are encrypted at rest. Only you can decrypt them by
        logging in
      </li>
      <li>
        <strong>Your responsibilities</strong> - You are responsible for
        providing a privacy policy, having lawful basis for collecting data,
        responding to data subject requests, and compliance with your local data
        protection laws
      </li>
      <li>
        <strong>Breach notification</strong> - We will notify you promptly if we
        detect a security incident affecting your data
      </li>
      <li>
        <strong>Deletion</strong> - Your data is deleted when you delete your
        events or close your account
      </li>
    </ol>
    <p class="password-warning">
      If you lose your password you will be <u>permanently</u> unable to view
      attendee lists. Do not lose your password.
    </p>
    <div class="field">
      <label>
        <input type="checkbox" name="accept_agreement" value="yes" required />I
        understand and accept these terms
      </label>
    </div>
  </fieldset>
);

/**
 * Initial setup page
 */
export const setupPage = (error?: string): string =>
  String(
    <Layout title="Setup">
      <CsrfForm action="/setup/">
        <h1>Initial Setup</h1>
        <p>Welcome! Please configure your ticket reservation system.</p>
        <Flash error={error} />
        <Raw html={renderFields(setupFields)} />
        <div class="field">
          <label>
            Your Country
            <select name="country" required>
              {Object.entries(COUNTRIES).map(([code, data]) => (
                <option value={code} selected={code === DEFAULT_COUNTRY}>
                  {data.name} ({data.currency})
                </option>
              ))}
            </select>
          </label>
          <p class="hint">Sets your timezone, currency, and phone prefix.</p>
        </div>
        <DataControllerAgreement />
        <button type="submit">Complete Setup</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Setup complete page
 */
export const setupCompletePage = (): string =>
  String(
    <Layout title="Setup Complete">
      <h1>Setup Complete!</h1>
      <div class="success" role="alert">
        <p>Your ticket reservation system has been configured successfully.</p>
      </div>
      <p>
        <a href="/admin/">
          <b>Go to Admin Dashboard</b>
        </a>
      </p>
    </Layout>,
  );
