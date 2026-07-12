/**
 * Render a run of labelled text inputs from a field list.
 *
 * Forms that carry their fields as data — the wallet settings forms and the
 * duplicate-group form — share this one loop over {@link TextField} instead of
 * each mapping over it themselves.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { TextField } from "#templates/components/text-field.tsx";

/** One labelled text input, described as data. */
export type TextFieldSpec = {
  label: Child;
  name: string;
  placeholder?: string | undefined;
  type: string;
  value?: string | undefined;
};

export const TextFields = ({
  duplicate,
  fields,
}: {
  /** Mark every field for the live duplicate-preview client script. */
  duplicate?: boolean | undefined;
  fields: readonly TextFieldSpec[];
}): JSX.Element => (
  <>
    {fields.map((field) => (
      <TextField
        duplicate={duplicate}
        label={field.label}
        name={field.name}
        placeholder={field.placeholder}
        type={field.type}
        value={field.value}
      />
    ))}
  </>
);
