/**
 * Admin login page template
 */

import { renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { loginFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Admin login page
 */
export const adminLoginPage = (csrfToken: string, error?: string): string =>
  String(
    <Layout title="Login">
      <Raw html={renderError(error)} />
      <form method="POST" action="/admin/login">
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <Raw html={renderFields(loginFields)} />
        <button type="submit">Login</button>
      </form>
    </Layout>
  );
