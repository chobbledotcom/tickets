/**
 * Admin login page template
 */

import { CsrfForm, renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { loginFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Admin login page
 */
export const adminLoginPage = (error?: string): string =>
  String(
    <Layout title="Login">
      <Raw html={renderError(error)} />
      <CsrfForm action="/admin/login">
        <Raw html={renderFields(loginFields)} />
        <button type="submit">Login</button>
      </CsrfForm>
    </Layout>
  );
