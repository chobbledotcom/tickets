/**
 * The "flow complete — ready to log in" page shared by `/setup/` (initial setup
 * finished) and `/join/:code` (invited user set their password). A heading, a
 * success alert with one or more message lines, and a login ActionButton.
 *
 * `messages` is an array so a single code path serves one message (setup) and
 * several (join) — see AGENTS.md "One path for one-or-many".
 */

import { ActionButton } from "#templates/components/actions.tsx";
import { PageLayout } from "#templates/components/page-layout.tsx";
import { Layout } from "#templates/layout.tsx";

export const SuccessCompletePage = ({
  title,
  heading,
  messages,
  loginLink,
}: {
  title: string;
  heading: string;
  messages: string[];
  loginLink: string;
}): string =>
  String(
    <Layout title={title}>
      <PageLayout>
        <h1>{heading}</h1>
        <div class="success" role="alert">
          {messages.map((message) => (
            <p>{message}</p>
          ))}
        </div>
        <p class="actions">
          <ActionButton href="/admin/login" icon="log-in">
            {loginLink}
          </ActionButton>
        </p>
      </PageLayout>
    </Layout>,
  );
