/**
 * Admin settings page template
 */

import { renderFields } from "#lib/forms.tsx";
import { Raw } from "#jsx/jsx-runtime.ts";
import { changePasswordFields, stripeKeyFields } from "../fields.ts";
import { Layout } from "../layout.tsx";

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
    <Layout title="Admin Settings">
      <h1>Admin Settings</h1>
      <p><a href="/admin/">&larr; Back to Dashboard</a></p>

      {error && <div class="error">{error}</div>}
      {success && <div class="success">{success}</div>}

      <h2>Stripe Settings</h2>
      <p>
        {stripeKeyConfigured
          ? "A Stripe secret key is currently configured. Enter a new key below to replace it."
          : "No Stripe key is configured. Payments are disabled."}
      </p>
      <form method="POST" action="/admin/settings/stripe">
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <Raw html={renderFields(stripeKeyFields)} />
        <button type="submit">Update Stripe Key</button>
      </form>

      <h2>Change Password</h2>
      <p>Changing your password will log you out of all sessions.</p>
      <form method="POST" action="/admin/settings">
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <Raw html={renderFields(changePasswordFields)} />
        <button type="submit">Change Password</button>
      </form>
    </Layout>
  );
