/**
 * Admin settings page template
 */

import { renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { changePasswordFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Admin settings page
 * Note: Stripe keys are now configured via environment variables
 */
export const adminSettingsPage = (csrfToken: string, error?: string): string =>
  String(
    <Layout title="Admin Settings">
      <header>
        <h1>Admin Settings</h1>
        <nav>
          <a href="/admin/">&larr; Back to Dashboard</a>
        </nav>
      </header>

      {error && <div class="error">{error}</div>}

      <section>
        <form method="POST" action="/admin/settings">
          <header>
            <h2>Change Password</h2>
          </header>
          <p>Changing your password will log you out of all sessions.</p>
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <Raw html={renderFields(changePasswordFields)} />
          <button type="submit">Change Password</button>
        </form>
      </section>
    </Layout>
  );
