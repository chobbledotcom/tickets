/**
 * Setup page templates - initial configuration
 */

import { renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { setupFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Initial setup page
 */
export const setupPage = (error?: string, csrfToken?: string): string =>
  String(
    <Layout title="Setup">
      <header>
        <h1>Initial Setup</h1>
        <p>Welcome! Please configure your ticket reservation system.</p>
      </header>
      <section>
        <Raw html={renderError(error)} />
        <form method="POST" action="/setup/">
          {csrfToken && <input type="hidden" name="csrf_token" value={csrfToken} />}
          <Raw html={renderFields(setupFields, { currency_code: "GBP" })} />
          <button type="submit">Complete Setup</button>
        </form>
      </section>
    </Layout>
  );

/**
 * Setup complete page
 */
export const setupCompletePage = (): string =>
  String(
    <Layout title="Setup Complete">
      <header>
        <h1>Setup Complete!</h1>
      </header>
      <section>
        <div class="success">
          <p>Your ticket reservation system has been configured successfully.</p>
        </div>
        <p>
          <a href="/admin/"><b>Go to Admin Dashboard</b></a>
        </p>
      </section>
    </Layout>
  );
