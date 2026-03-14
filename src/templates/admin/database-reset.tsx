/**
 * Reset database shared form component and standalone demo reset page.
 * The ResetDatabaseForm component is reused in admin settings.
 */

import { CsrfForm, renderError } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";

/** Confirmation phrase that must be typed to reset the database */
export const RESET_DATABASE_PHRASE =
  "The site will be fully reset and all data will be lost.";

/** Error message when the confirmation phrase doesn't match */
export const RESET_PHRASE_MISMATCH_ERROR =
  "Confirmation phrase does not match. Please type the exact phrase to confirm reset.";

/** Shared reset database form - used on both admin settings and demo reset pages */
export const ResetDatabaseForm = (
  { action, id }: { action: string; id?: string },
): JSX.Element => (
  <CsrfForm action={action} id={id}>
    <h2>Reset Database</h2>
    <article>
      <aside>
        <p>
          <strong>Warning:</strong>{" "}
          This will permanently delete all events, attendees, settings, and
          other data. This action cannot be undone.
        </p>
      </aside>
    </article>
    <p>To reset the database, type the following phrase into the box below:</p>
    <p>
      <strong>"{RESET_DATABASE_PHRASE}"</strong>
    </p>
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
  </CsrfForm>
);

/**
 * Demo reset standalone page - accessible without login when DEMO_MODE is enabled
 */
export const demoResetPage = (error?: string): string =>
  String(
    <Layout title="Reset Database">
      <Raw html={renderError(error)} />
      <ResetDatabaseForm action="/demo/reset" />
      <p>
        <a href="/admin">Back to login</a>
      </p>
    </Layout>,
  );
