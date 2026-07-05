import {
  type Field,
  type FieldValues,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";

/** A form's error/success flash directly above its rendered fields — the shared
 *  top of the built-site and modifier edit forms, where a header sits above and
 *  the save button below. */
export const FlashFields = ({
  error,
  success,
  fields,
  values,
}: {
  error?: string | undefined;
  success?: string | undefined;
  fields: Field[];
  values?: FieldValues;
}): JSX.Element => (
  <>
    <Flash error={error} success={success} />
    <Raw html={renderFields(fields, values)} />
  </>
);
