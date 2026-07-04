import { type Field, renderFields } from "#shared/forms.tsx";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { adminRecalculatePage } from "#templates/admin/recalculate.tsx";
/** A labelled checkboxes fieldset shell: `class` + legend + hint note, wrapping
 *  the caller's checkbox rows (or an empty-state) as `children`. Shared so the
 *  per-page selectors don't each re-spell the fieldset/legend/hint scaffold. */
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
  <fieldset class={className}>
    <legend>{legend}</legend>
    <p>
      <small>{hint}</small>
    </p>
    {children}
  </fieldset>
);

/** A single `<label><input type="checkbox" …/>{label}</label>` line. Shared by
 *  every checkbox-list fieldset so the markup lives in exactly one place. */
export const CheckboxLabel = ({
  checked,
  label,
  name,
  value,
}: {
  checked: boolean | undefined;
  label: string;
  name: string;
  value: string;
}): JSX.Element => (
  <label>
    <input checked={checked} name={name} type="checkbox" value={value} />
    {label}
  </label>
);

/** A checkbox-select fieldset over an option list. `noneMessage` shows in
 *  place of the fieldset when there are no options to pick from. */
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

/** "Running totals" fieldset shared between modifier and answer edit pages:
 *  legend, optional drift-notice prefix, small note, editable aggregate fields,
 *  and a link to the recalculate page. */
export type RunningTotalsConfig = {
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
  <fieldset>
    <legend>{config.legend}</legend>
    {children}
    <p>
      <small>{config.note}</small>
    </p>
    <Raw html={renderFields(config.fields, config.values)} />
    <p>
      <a href={config.recalculateHref}>{config.recalculateLabel}</a>
    </p>
  </fieldset>
);

/** Curried helper that produces a recalculate-page renderer from the static
 *  config (action, labels, rows). Each entity (listing/modifier/answer) builds
 *  its config once, then applies the per-request `(session, error?, success?)`
 *  to render — keeping the call-site signature uniform without duplicating the
 *  `(session, error?, success?) => adminRecalculatePage({…, session, error,
 *  success})` boilerplate at every definition. */
export const recalculatePageRenderer =
  (
    config: Omit<
      Parameters<typeof adminRecalculatePage>[0],
      "error" | "session" | "success"
    >,
  ): ((session: AdminSession, error?: string, success?: string) => string) =>
  (session, error, success) =>
    adminRecalculatePage({ ...config, error, session, success });
