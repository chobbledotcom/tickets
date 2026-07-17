/**
 * A tiny inline form with one small text button — the shape shared by the
 * reorder arrows and per-row actions like "remove". Posting through a form
 * keeps every state-changing action a CSRF-checked POST, never a bare link.
 */

import { CsrfForm } from "#shared/forms/csrf-form.tsx";

export const InlineFormButton = ({
  action,
  title,
  children,
}: {
  action: string;
  title?: string | undefined;
  children: JSX.Element | string;
}): JSX.Element => (
  <CsrfForm action={action} class="inline">
    <button class="link-button small" title={title} type="submit">
      {children}
    </button>
  </CsrfForm>
);
