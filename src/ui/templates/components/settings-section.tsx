/**
 * Shared wrapper for an admin settings section.
 *
 * Every settings form is the same shell: a CSRF-protected POST form whose
 * heading and intro sit in a `.prose` block, the section's own fields in the
 * middle, and a single save button at the foot. This captures that skeleton so
 * each section only declares its `action`, `id`, copy, and fields — passing the
 * intro paragraph as `description` and the fields as children.
 *
 * Sections that don't share the shape (a bare `<h2>`, a button mid-form, a
 * secondary action in a `<footer>`) keep using {@link CsrfForm} directly.
 */

import type { Child } from "#jsx/jsx-runtime.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";

export const SettingsSection = ({
  action,
  description,
  enctype,
  id,
  submitLabel,
  title,
  children,
}: {
  action: string;
  /** Intro paragraph(s) shown under the heading, inside the `.prose` block. */
  description?: Child;
  /** Set for forms that upload files (e.g. `multipart/form-data`). */
  enctype?: string;
  id: string;
  submitLabel: string;
  title: string;
  children?: Child;
}): JSX.Element => (
  <CsrfForm action={action} enctype={enctype} id={id}>
    <div class="prose">
      <h2>{title}</h2>
      {description}
    </div>
    {children}
    <SubmitButton icon="save">{submitLabel}</SubmitButton>
  </CsrfForm>
);
