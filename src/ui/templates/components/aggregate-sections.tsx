import { CsrfForm, type Field, renderFields } from "#shared/forms.tsx";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { adminRecalculatePage } from "#templates/admin/recalculate.tsx";
import { type IconName, SubmitButton } from "#templates/components/actions.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";

type StackBaseProps = {
  children: Child;
  className?: string | undefined;
};

/** A form section: a bordered-off group of fields led by a <legend>. The
 * fieldset is already a flex column with the standard gap, so its children
 * stack on their own — no wrapper needed. */
export const SectionFieldset = ({
  children,
  className,
  legend,
}: StackBaseProps & { legend: string }): JSX.Element => (
  <fieldset class={className}>
    <legend>{legend}</legend>
    {children}
  </fieldset>
);

/**
 * One section of a form: a heading (rendered as the fieldset's <legend>) and
 * the fields that belong under it. This is the ONLY shape a form section takes
 * — model a form as a `FormSection[]` and render it with {@link FormSections},
 * so a section header can never drift back into a hand-rolled <h3>. Build the
 * list with `compact` to drop sections that don't apply (see the attendee
 * form's `editFormSections`).
 *
 * A blank or absent `className` falls back to the shared "listing-section"
 * legend styling; pass a `className` to override it — include "listing-section"
 * plus any modifier, as the listing form's daily section does.
 */
export type FormSection = {
  legend: string;
  className?: string | undefined;
  children: Child;
};

/** Render a form's `FormSection[]` as a run of {@link SectionFieldset}s. */
export const FormSections = ({
  sections,
}: {
  sections: readonly FormSection[];
}): JSX.Element => (
  <>
    {sections.map((section) => (
      <SectionFieldset
        className={section.className || "listing-section"}
        legend={section.legend}
      >
        {section.children}
      </SectionFieldset>
    ))}
  </>
);

export const StackDetails = ({
  children,
  className,
  open,
  summary,
}: StackBaseProps & {
  open?: boolean;
  summary: string;
}): JSX.Element => (
  <details class={className} open={open}>
    <summary>{summary}</summary>
    <PageBlock>{children}</PageBlock>
  </details>
);

export const CheckboxFieldset = ({
  children,
  className,
  hint,
  legend,
}: {
  children: Child;
  className: string;
  hint: string;
  legend: string;
}): JSX.Element => (
  <SectionFieldset className={className} legend={legend}>
    <p>
      <small>{hint}</small>
    </p>
    {children}
  </SectionFieldset>
);

export const CheckboxLabel = ({
  checked,
  children,
  className,
  disabled,
  label,
  name,
  value,
}: {
  checked: boolean | undefined;
  children?: Child;
  className?: string | undefined;
  disabled?: boolean;
  label: Child;
  name: string;
  value?: string;
}): JSX.Element => (
  <label class={className}>
    <input
      checked={checked}
      disabled={disabled || undefined}
      name={name}
      type="checkbox"
      value={value}
    />
    {label}
    {children}
  </label>
);

export const IdCheckboxLabel = ({
  checkedIds,
  children,
  id,
  label,
  name,
}: {
  checkedIds: ReadonlySet<number>;
  children?: Child;
  id: number;
  label: Child;
  name: string;
}): JSX.Element => (
  <CheckboxLabel
    checked={checkedIds.has(id) || undefined}
    label={label}
    name={name}
    value={String(id)}
  >
    {children}
  </CheckboxLabel>
);

export const CheckboxesFieldset = <T extends { id: number; name: string }>({
  fieldName,
  noneMessage,
  options,
  selected,
}: {
  fieldName: string;
  noneMessage: string;
  options: T[];
  selected: number[];
}): JSX.Element =>
  options.length === 0 ? (
    <p>{noneMessage}</p>
  ) : (
    <fieldset class="checkboxes">
      {options.map((o) => (
        <CheckboxLabel
          checked={selected.includes(o.id) || undefined}
          label={` ${o.name}`}
          name={fieldName}
          value={String(o.id)}
        />
      ))}
    </fieldset>
  );

export const CheckboxForm = ({
  action,
  children,
  id,
  submitIcon = "save",
  submitLabel,
}: {
  action: string;
  children: Child;
  id?: string;
  submitIcon?: IconName;
  submitLabel: string;
}): JSX.Element => (
  <CsrfForm action={action} id={id}>
    <fieldset class="checkboxes">{children}</fieldset>
    <SubmitButton icon={submitIcon}>{submitLabel}</SubmitButton>
  </CsrfForm>
);

export type RunningTotalsConfig = {
  className?: string;
  fields: Field[];
  legend: string;
  note: string;
  recalculateHref: string;
  recalculateLabel: string;
  values: Record<string, string | number | null>;
};

export const RunningTotalsFieldset = ({
  children,
  config,
}: {
  children?: JSX.Element;
  config: RunningTotalsConfig;
}): JSX.Element => (
  <SectionFieldset className={config.className} legend={config.legend}>
    {children}
    <p>
      <small>{config.note}</small>
    </p>
    <Raw html={renderFields(config.fields, config.values)} />
    <p>
      <a href={config.recalculateHref}>{config.recalculateLabel}</a>
    </p>
  </SectionFieldset>
);

export const recalculatePageRenderer =
  (
    config: Omit<
      Parameters<typeof adminRecalculatePage>[0],
      "error" | "session" | "success"
    >,
  ): ((session: AdminSession, error?: string, success?: string) => string) =>
  (session, error, success) =>
    adminRecalculatePage({ ...config, error, session, success });
