/**
 * A CSRF-protected POST form that ends with a single save-style submit button.
 *
 * This is the shared tail of every "fill in the fields, press save" form —
 * the admin settings sections and the money-adjust panels all close the same
 * way. Owning the button row here keeps those forms from each re-writing it.
 */

import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { hiddenInputs } from "#shared/forms/hidden-inputs.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { ReturnUrlField } from "#shared/return-url-field.tsx";
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

type ConfirmFormProps = {
  action: string;
  name?: string;
  label?: string;
  buttonText: string;
  danger?: boolean;
  returnUrl?: string | undefined;
  id?: string;
  hiddenFields?: Record<string, string>;
  /** When false, omit the type-the-name input — a plain are-you-sure page. */
  confirmName?: boolean;
  children?: Child;
};

/** A confirm-and-submit form: the shared save-form scaffold, filled with an
 *  optional prose intro, the return-url and any hidden fields, and (unless
 *  `confirmName` is false) the type-the-name box. A `danger` action turns the
 *  submit button red and swaps its icon to the bin. */
export const ConfirmForm = saveFormComponent<ConfirmFormProps>(
  ({
    name,
    label,
    buttonText,
    danger = true,
    returnUrl,
    hiddenFields,
    confirmName = true,
    children,
  }) => ({
    submitIcon: danger ? "trash-2" : "check",
    submitLabel: buttonText,
    ...(danger ? { submitClass: "danger" } : {}),
    children: (
      <>
        {children && <div class="prose">{children}</div>}
        <ReturnUrlField returnUrl={returnUrl} />
        {hiddenFields && hiddenInputs(Object.entries(hiddenFields))}
        {confirmName && (
          <label>
            {label}
            <input
              autocomplete="off"
              name="confirm_identifier"
              placeholder={name}
              required
              type="text"
            />
          </label>
        )}
      </>
    ),
  }),
);
