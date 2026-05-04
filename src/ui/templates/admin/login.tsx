/**
 * Admin login page template
 */

import { isDemoMode } from "#shared/demo.ts";
import { CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { loginFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Admin login page
 */
export const adminLoginPage = (error?: string): string =>
  String(
    <Layout title="Login">
      <Flash error={error} />
      <CsrfForm action="/admin/login">
        <Raw html={renderFields(loginFields)} />
        <button type="submit">Login</button>
      </CsrfForm>
      {isDemoMode() && (
        <p>
          <a href="/demo/reset">Reset database</a>
        </p>
      )}
    </Layout>,
  );
