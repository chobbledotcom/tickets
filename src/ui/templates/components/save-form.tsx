/**
 * A CSRF-protected POST form that ends with a single save-style submit button.
 *
 * This is the shared tail of every "fill in the fields, press save" form —
 * the admin settings sections and the money-adjust panels all close the same
 * way. Owning the button row here keeps those forms from each re-writing it.
 */

import { CsrfForm } from "#shared/forms.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { type IconName, SubmitButton } from "#templates/components/actions.tsx";

export const SaveForm = ({
  action,
  class: className,
  enctype,
  id,
  submitLabel,
  submitIcon = "save",
  submitClass,
  children,
}: {
  action: string;
  class?: string | undefined;
  /** Set for forms that upload files (e.g. `multipart/form-data`). */
  enctype?: string | undefined;
  id?: string | undefined;
  submitLabel: string;
  /** Submit-button icon; defaults to the save icon. */
  submitIcon?: IconName;
  /** Class for the submit button, e.g. "danger" for a destructive action. */
  submitClass?: string;
  children?: Child;
}): JSX.Element => (
  <CsrfForm
    action={action}
    {...(className !== undefined ? { class: className } : {})}
    {...(enctype !== undefined ? { enctype } : {})}
    id={id}
  >
    {children}
    <SubmitButton
      icon={submitIcon}
      {...(submitClass !== undefined ? { class: submitClass } : {})}
    >
      {submitLabel}
    </SubmitButton>
  </CsrfForm>
);

/** Build a form component that wraps its body in a {@link SaveForm}. Give it a
 *  function from the component's props to the form's submit configuration and
 *  body; the factory wires the shared `<SaveForm action id …>` scaffold once, so
 *  no two "fields, then save" form components repeat it. Any props type that
 *  carries an `action` (and optional `id`) works, so a new such form is one
 *  `saveFormComponent(...)` call rather than another hand-written wrapper. */
export const saveFormComponent =
  <P extends { action: string; id?: string }>(
    toForm: (props: P) => {
      submitLabel: string;
      submitIcon?: IconName;
      submitClass?: string;
      enctype?: string;
      class?: string;
      children: Child;
    },
  ) =>
  (props: P): JSX.Element => {
    const { children, ...form } = toForm(props);
    return (
      <SaveForm action={props.action} id={props.id} {...form}>
        {children}
      </SaveForm>
    );
  };
