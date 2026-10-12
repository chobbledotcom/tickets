import * as v from "valibot";
import { commaParts } from "#shared/split.ts";
import { isContactField } from "#types";

/** The `fields` column: a comma-separated list of valid contact-field names,
 * so a typo ("fax") is a field error rather than a silently-dropped entry.
 * The parse matches the booking form's own read of the same string. */
export const fieldsSchema = v.pipe(
  v.string(),
  v.transform(commaParts),
  v.array(
    v.custom<string>(
      (value) => typeof value === "string" && isContactField(value),
      "must be a known contact field",
    ),
  ),
  v.transform((parts) => parts.join(",")),
);

/** The same rule for an update, where the caller can leave the column alone. */
export const optionalFieldsSchema = v.optional(fieldsSchema);
