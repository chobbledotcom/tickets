/**
 * Join (invite) page templates
 */

import { joinForm } from "#routes/join.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";

/**
 * Join page - set password for invited user
 */
export const joinPage = (
  code: string,
  username: string,
  error?: string,
): string =>
  String(
    <Layout title="Set Your Password">
      <CsrfForm action={`/join/${code}`}>
        <div class="prose">
          <h1>Welcome, {username}</h1>
          <p>Set your password to complete your account setup.</p>
        </div>
        <Flash error={error} />
        <Raw html={joinForm.render()} />
        <button type="submit">Set Password</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Join complete page - password set, waiting for activation
 */
export const joinCompletePage = (): string =>
  String(
    <Layout title="Account Created">
      <h1>Password Set</h1>
      <div class="success" role="alert">
        <p>Your password has been set successfully.</p>
        <p>
          Please wait for the site owner to activate your account before logging
          in.
        </p>
      </div>
    </Layout>,
  );

/**
 * Join error page - invalid or expired invite
 */
export const joinErrorPage = (message: string): string =>
  String(
    <Layout title="Invalid Invite">
      <h1>Invalid Invite</h1>
      <Flash error={message} />
    </Layout>,
  );
