/**
 * Admin login page template
 */

import { renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#jsx/jsx-runtime.ts";
import { loginFields } from "../fields.ts";
import { Layout } from "../layout.tsx";

/**
 * Admin login page
 */
export const adminLoginPage = (error?: string): string =>
  String(
    <Layout title="Admin Login">
      <h1>Admin Login</h1>
      <Raw html={renderError(error)} />
      <form method="POST" action="/admin/login">
        <Raw html={renderFields(loginFields)} />
        <button type="submit">Login</button>
      </form>
    </Layout>
  );
