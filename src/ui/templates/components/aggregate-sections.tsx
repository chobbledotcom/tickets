import { type Field, renderFields, SubmitForm } from "#shared/forms.tsx";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { adminRecalculatePage } from "#templates/admin/recalculate.tsx";
import type { IconName } from "#templates/components/actions.tsx";

type StackBaseProps = {
  children: Child;
  className?: string | undefined;
};

const FieldsetBox = ({
  children,
  className,
  legend,
}: StackBaseProps & { legend: string }): JSX.Element => (
  <fieldset class={className}>
    <legend>{legend}</legend>
    {children}
  </fieldset>
);

export const StackFieldset = (
  props: StackBaseProps & { legend: string },
): JSX.Element => (
  <FieldsetBox className={props.className} legend={props.legend}>
    <div class="stack">{props.children}</div>
  </FieldsetBox>
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
    <div class="stack">{children}</div>
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
  <FieldsetBox className={className} legend={legend}>
    <p>
      <small>{hint}</small>
    </p>
    {children}
  </FieldsetBox>
);

export const CheckboxLabel = ({
  checked,
  children,
  disabled,
  label,
  name,
  value,
}: {
  checked: boolean | undefined;
  children?: Child;
  disabled?: boolean;
  label: Child;
  name: string;
  value?: string;
}): JSX.Element => (
  <label>
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

/** One "tick the ones that apply" checkbox per entity for a multi-select field:
 *  each label is the entity's name, ticked when its id is in `selected`. The
 *  single place a list of named things becomes name-labelled checkboxes, so the
 *  listing/answer/group pickers all read the same. */
export const entityCheckboxes = <T extends { id: number; name: string }>({
  entities,
  fieldName,
  selected,
}: {
  entities: readonly T[];
  fieldName: string;
  selected?: ReadonlySet<number>;
}): JSX.Element[] =>
  entities.map((entity) => (
    <CheckboxLabel
      checked={selected?.has(entity.id) || undefined}
      label={` ${entity.name}`}
      name={fieldName}
      value={String(entity.id)}
    />
  ));

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
      {entityCheckboxes({
        entities: options,
        fieldName,
        selected: new Set(selected),
      })}
    </fieldset>
  );

export const CheckboxForm = ({
  children,
  ...rest
}: {
  action: string;
  children: Child;
  id?: string;
  submitIcon?: IconName;
  submitLabel: string;
}): JSX.Element => (
  <SubmitForm {...rest}>
    <fieldset class="checkboxes">{children}</fieldset>
  </SubmitForm>
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
  <StackFieldset className={config.className} legend={config.legend}>
    {children}
    <p>
      <small>{config.note}</small>
    </p>
    <Raw html={renderFields(config.fields, config.values)} />
    <p>
      <a href={config.recalculateHref}>{config.recalculateLabel}</a>
    </p>
  </StackFieldset>
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
