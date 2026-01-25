/**
 * Admin settings page template
 */

import { renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { changePasswordFields, stripeKeyFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

/**
 * Admin settings page
 */
export const adminSettingsPage = (
  csrfToken: string,
  stripeKeyConfigured: boolean,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Settings">
      <AdminNav />

      {error && <div class="error">{error}</div>}
      {success && <div class="success">{success}</div>}

        <form method="POST" action="/admin/settings/stripe">
            <h2>Stripe Settings</h2>
          <p>
            {stripeKeyConfigured
              ? "A Stripe secret key is currently configured. Enter a new key below to replace it."
              : "No Stripe key is configured. Payments are disabled."}
          </p>
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <Raw html={renderFields(stripeKeyFields)} />
          <button type="submit">Update Stripe Key</button>
        </form>

        <form method="POST" action="/admin/settings">
            <h2>Change Password</h2>
          <p>Changing your password will log you out of all sessions.</p>
          <input type="hidden" name="csrf_token" value={csrfToken} />
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
          <input type="hidden" name="csrf_token" value={csrfToken} />
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
