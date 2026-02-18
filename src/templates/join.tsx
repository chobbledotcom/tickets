/**
 * Join (invite) page templates
 */

import { CsrfForm, renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { joinFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Join page - set password for invited user
 */
export const joinPage = (
  code: string,
  username: string,
  error: string | undefined,
  csrfToken: string,
): string =>
  String(
    <Layout title="Set Your Password">
      <h1>Welcome, {username}</h1>
      <p>Set your password to complete your account setup.</p>
      <Raw html={renderError(error)} />
      <CsrfForm action={`/join/${code}`} csrfToken={csrfToken}>
        <Raw html={renderFields(joinFields)} />
        <button type="submit">Set Password</button>
      </CsrfForm>
    </Layout>
  );

/**
 * Join complete page - password set, waiting for activation
 */
export const joinCompletePage = (): string =>
  String(
    <Layout title="Account Created">
      <h1>Password Set</h1>
      <div class="success">
        <p>Your password has been set successfully.</p>
        <p>Please wait for the site owner to activate your account before logging in.</p>
      </div>
    </Layout>
  );

/**
 * Join error page - invalid or expired invite
 */
export const joinErrorPage = (message: string): string =>
  String(
    <Layout title="Invalid Invite">
      <h1>Invalid Invite</h1>
      <div class="error">{message}</div>
    </Layout>
  );
