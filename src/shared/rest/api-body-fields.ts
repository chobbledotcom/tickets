/** The schema pieces the admin API write bodies share. A field is declared
 *  once as its create view and its update view. Each view carries the wire
 *  message its route answers. Valibot names a missing object key itself, so
 *  parseApiBody fills every declared key in before it parses. */

import * as v from "valibot";

/** One field's two views: the complete value a create takes, and the value an
 *  update takes. An update view is optional, so an absent key keeps the stored
 *  value. */
export type BodyField = {
  create: v.GenericSchema;
  update: v.GenericSchema;
};

/** The wire body one schema accepts: the type a caller sends. */
export type ApiBody<Schema extends v.GenericSchema> = v.InferOutput<Schema>;

/** One field's message: the required message when the key is absent, and the
 *  refused message otherwise. */
const issueMessage =
  (requiredMessage: string, refusedMessage: string) =>
  (issue: v.BaseIssue<unknown>): string =>
    issue.received === "undefined" ? requiredMessage : refusedMessage;

const fieldTypeMessage = (
  field: string,
  kind: string,
  requiredMessage: string,
) => issueMessage(requiredMessage, `${field} must be a ${kind}`);

/** The message for a date field: a missing value is required. Any other
 *  refusal is the field's invalid-value message. */
const dateMessage = (field: string) =>
  issueMessage(`${field} is required`, `${field} has an invalid value`);

/** The message for a picklist field: a missing value is required. Any other
 *  refusal answers the rule's own message. */
const picklistMessage = (field: string, refusedMessage: string) =>
  issueMessage(`${field} is required`, refusedMessage);

/** One required text field's two views. A create stores the text that its
 *  clean gives, then requires text. An empty result answers `emptyMessage`,
 *  which defaults to the required message. An update leaves the value to the
 *  mapper. The mapper answers the update's own message. */
export const textField = (
  field: string,
  requiredMessage = `${field} is required`,
  clean: (text: string) => string = (text) => text.trim(),
  emptyMessage = requiredMessage,
) => ({
  create: v.pipe(
    v.string(fieldTypeMessage(field, "string", requiredMessage)),
    v.transform(clean),
    v.nonEmpty(emptyMessage),
  ),
  update: v.string(`${field} must be a string`),
});

/** A required text field where any value that is not text answers the caller's
 *  message. The image file fields use it. */
export const nonEmptyTextField = (_field: string, message: string) =>
  v.pipe(v.string(message), v.trim(), v.nonEmpty(message));

/** An optional text field. */
export const optionalTextField = (field: string) => ({
  create: v.optional(v.string(`${field} must be a string`)),
  update: v.optional(v.string(`${field} must be a string`)),
});

/** An optional boolean switch. */
export const switchField = (field: string) => ({
  create: v.optional(v.boolean(`${field} must be a boolean`)),
  update: v.optional(v.boolean(`${field} must be a boolean`)),
});

/** A required date text. The create view is non-empty and trimmed. The update
 *  view leaves an empty value to the date reader. A value of the wrong type
 *  answers the field's invalid-value message on both views. */
export const dateField = (field: string) => ({
  create: v.pipe(
    v.string(dateMessage(field)),
    v.trim(),
    v.nonEmpty(`${field} is required`),
  ),
  update: v.string(`${field} has an invalid value`),
});

/** A required picklist. The create view answers "is required" for a missing
 *  value, and the rule's own message for any other refusal. The update view
 *  accepts an absent key. */
export const picklistField = <const Options extends readonly string[]>(
  field: string,
  options: Options,
  refusedMessage: string,
) => ({
  create: v.picklist(options, picklistMessage(field, refusedMessage)),
  update: v.optional(v.picklist(options, refusedMessage)),
});

/** The declared entries of an object schema, or null for any other schema. */
export const objectEntries = (
  schema: v.GenericSchema,
): Record<string, v.GenericSchema> | null => {
  if (!("entries" in schema)) return null;
  // A valibot object schema carries its entries as a record of schemas.
  return schema.entries as Record<string, v.GenericSchema>;
};

/** One view of every field: `create` for the complete body, `update` for the
 *  body an update takes. */
export const fieldViews = <
  Fields extends Record<string, BodyField>,
  View extends keyof BodyField,
>(
  fields: Fields,
  view: View,
): { [Key in keyof Fields]: Fields[Key][View] } =>
  Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, field[view]]),
  ) as { [Key in keyof Fields]: Fields[Key][View] };

/** The entries one verb's object schema carries: every field's view for that
 *  verb, plus the fields only that verb carries. */
type ViewEntries<
  Fields extends Record<string, BodyField>,
  View extends keyof BodyField,
  Only extends Record<string, v.GenericSchema>,
> = { [Key in keyof Fields]: Fields[Key][View] } & Only;

/** The same entries with every key optional, which is the update body. */
type OptionalEntries<Entries extends Record<string, v.GenericSchema>> = {
  [Key in keyof Entries]: v.OptionalSchema<Entries[Key], undefined>;
};

/** One resource's create and update bodies, from one field declaration. The
 *  update view makes every field optional, so an absent key keeps the stored
 *  value. A field only one verb carries goes in `createOnly` or `updateOnly`. */
export const apiBodyPair = <
  const Fields extends Record<string, BodyField>,
  const CreateOnly extends Record<string, v.GenericSchema> = Record<
    never,
    never
  >,
  const UpdateOnly extends Record<string, v.GenericSchema> = Record<
    never,
    never
  >,
>(
  fields: Fields,
  extra: { createOnly?: CreateOnly; updateOnly?: UpdateOnly } = {},
): {
  create: v.ObjectSchema<ViewEntries<Fields, "create", CreateOnly>, undefined>;
  update: v.ObjectSchema<
    OptionalEntries<ViewEntries<Fields, "update", UpdateOnly>>,
    undefined
  >;
} => {
  // The entries are the field views, so each schema's output is the body
  // type above.
  const createEntries: ViewEntries<Fields, "create", CreateOnly> = {
    ...fieldViews(fields, "create"),
    ...(extra.createOnly ?? ({} as CreateOnly)),
  };
  const updateEntries: ViewEntries<Fields, "update", UpdateOnly> = {
    ...fieldViews(fields, "update"),
    ...(extra.updateOnly ?? ({} as UpdateOnly)),
  };
  return {
    create: v.object(createEntries),
    update: v.object(
      // Each update field is optional, so an absent key keeps the stored
      // value.
      Object.fromEntries(
        Object.entries(updateEntries).map(([key, schema]) => [
          key,
          v.optional(schema),
        ]),
      ) as OptionalEntries<ViewEntries<Fields, "update", UpdateOnly>>,
    ),
  };
};

/** One admin API row: the fields the client reads plus the server-owned id.
 *  The row stays open, because the server owns the rest of the stored row. */
export const idRow = <const Entries extends Record<string, v.GenericSchema>>(
  entries: Entries,
) => v.looseObject({ ...entries, id: v.number() });
