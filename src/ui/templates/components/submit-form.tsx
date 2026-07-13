/**
 * A CSRF-protected form whose body ends with a primary submit button — the
 * shared shape behind every "fields then submit" form (the balance pay form,
 * the bulk-duplicate form, …). `action` is the POST target; `icon` and
 * `submitLabel` render the button; any `children` render above it.
 */

import type { Child } from "#jsx/jsx-runtime.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { type IconName, SubmitButton } from "#templates/components/actions.tsx";

export const SubmitForm = ({
  icon,
  submitLabel,
  children,
  ...rest
}: Parameters<typeof CsrfForm>[0] & {
  icon: IconName;
  submitLabel: Child;
}): JSX.Element => (
  <CsrfForm {...rest}>
    {children}
    <SubmitButton icon={icon}>{submitLabel}</SubmitButton>
  </CsrfForm>
);
