/**
 * The form primitives every built-site tab posts through: one CSRF form per
 * site action, and the two buttons that drive them.
 */

import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import {
  Icon,
  type IconName,
  SubmitButton,
} from "#templates/components/actions.tsx";

export const SiteActionForm = ({
  siteId,
  action,
  children,
}: {
  siteId: number;
  action: string;
  children: Child;
}): JSX.Element => (
  <WritableOnly>
    <CsrfForm action={`/admin/built-sites/${siteId}/${action}`}>
      {children}
    </CsrfForm>
  </WritableOnly>
);

export const TranslatedSubmitButton = ({
  icon,
  labelKey,
}: {
  icon: IconName;
  labelKey: string;
}): JSX.Element => <SubmitButton icon={icon}>{t(labelKey)}</SubmitButton>;

export const ConfirmActionButton = ({
  action,
  confirmKey,
  icon,
  labelKey,
  siteId,
}: {
  action: string;
  confirmKey: string;
  icon: IconName;
  labelKey: string;
  siteId: number;
}): JSX.Element => (
  <SiteActionForm action={action} siteId={siteId}>
    <button onclick={`return confirm('${t(confirmKey)}')`} type="submit">
      <Icon name={icon} />
      <span>{t(labelKey)}</span>
    </button>
  </SiteActionForm>
);
