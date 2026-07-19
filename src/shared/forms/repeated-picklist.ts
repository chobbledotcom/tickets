import * as v from "valibot";
import type { FormParams } from "#shared/form-data.ts";

type PicklistOptions = readonly [string, ...string[]];

export type RepeatedPicklistValue<TValue extends string> =
  | { state: "disabled" }
  | { state: "absent" }
  | { state: "invalid"; value: string }
  | { state: "selected"; values: TValue[] };

/** Read a repeated form field against one ordered picklist schema. */
export const readRepeatedPicklist = <const TOptions extends PicklistOptions>(
  schema: v.PicklistSchema<TOptions, undefined>,
  form: FormParams,
  name: string,
  enabled = true,
): RepeatedPicklistValue<TOptions[number]> => {
  if (!enabled) return { state: "disabled" };
  if (!form.has(name)) return { state: "absent" };

  const supplied = form.getAll(name);
  const invalid = supplied.find((value) => !v.safeParse(schema, value).success);
  if (invalid !== undefined) return { state: "invalid", value: invalid };

  const selected = new Set(supplied);
  return {
    state: "selected",
    values: schema.options.filter((value) => selected.has(value)),
  };
};
