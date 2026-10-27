/** The agent's describe document: every resource's verbs, bodies, children,
 *  and custom routes, read off the admin api table. */
import type * as v from "valibot";
import {
  type AdminApiChild,
  type AdminApiCustomRoute,
  type AdminApiResource,
  adminApiIdParam,
  DeleteBodySchema,
} from "#shared/admin-api-resources.ts";

/** One body field as describe reports it: its name, its JSON type, and
 *  whether a write must carry it. */
export type FieldDoc = {
  items?: { type: string };
  fields?: FieldDoc[];
  name: string;
  required: boolean;
  type: string;
};

/** One verb's body: the table's fields, or the note that the server owns
 *  the validation. */
export type BodyDoc =
  | { fields: FieldDoc[]; kind: "fields" }
  | { kind: "server" };

/** The schema shapes describe reads off valibot's runtime objects. */
type EntriesSchema = v.GenericSchema & {
  entries: Record<string, v.GenericSchema>;
};
type WrappedSchema = v.GenericSchema & { wrapped: v.GenericSchema };
type ItemSchema = v.GenericSchema & { item: v.GenericSchema };

const isEntries = (schema: v.GenericSchema): schema is EntriesSchema =>
  "entries" in schema;

const isWrapped = (schema: v.GenericSchema): schema is WrappedSchema =>
  "wrapped" in schema;

const isItem = (schema: v.GenericSchema): schema is ItemSchema =>
  "item" in schema;

/** Read one field's JSON type and nested shape off its schema. A schema the
 *  walker cannot name answers "unknown" rather than a guess. */
const fieldDoc = (
  name: string,
  schema: v.GenericSchema,
  required: boolean,
): FieldDoc => {
  if (isWrapped(schema)) {
    // An optional key a write may omit; a nullable key must travel, so its
    // requiredness stays as it is.
    return schema.type === "optional"
      ? fieldDoc(name, schema.wrapped, false)
      : fieldDoc(name, schema.wrapped, required);
  }
  if (isItem(schema)) {
    return {
      items: { type: fieldDoc("", schema.item, true).type },
      name,
      required,
      type: "array",
    };
  }
  if (isEntries(schema)) {
    return { fields: fieldsOf(schema.entries), name, required, type: "object" };
  }
  if (
    schema.type === "boolean" ||
    schema.type === "number" ||
    schema.type === "string"
  ) {
    return { name, required, type: schema.type };
  }
  return { name, required, type: "unknown" };
};

const fieldsOf = (entries: Record<string, v.GenericSchema>): FieldDoc[] =>
  Object.entries(entries).map(([name, schema]) => fieldDoc(name, schema, true));

/** One verb's body document, read off the schema the table declares. A body
 *  schema the table carries must be an object schema; anything else is a
 *  table bug the CLI refuses. */
const bodyDoc = (schema: v.GenericSchema | undefined): BodyDoc => {
  if (!schema) return { kind: "server" };
  if (!isEntries(schema)) {
    throw new Error(
      "a body schema in the admin api table must be an object schema",
    );
  }
  return { fields: fieldsOf(schema.entries), kind: "fields" };
};

export type VerbDoc = { body?: BodyDoc };

export type ChildDoc = {
  idParam: string;
  path: string;
  verbs: Record<"create" | "delete" | "update", VerbDoc>;
};

export type CustomRouteDoc = { method: string; subpath: string };

export type ResourceDoc = {
  children: Record<string, ChildDoc>;
  customRoutes: Record<string, CustomRouteDoc>;
  idParam: string;
  label: string;
  path: string;
  /** The standard verbs the resource serves, keyed by verb. A create-only
   *  resource lists only `create`. */
  verbs: Partial<
    Record<"create" | "delete" | "get" | "list" | "update", VerbDoc>
  >;
};

export type DescribeDoc = { resources: Record<string, ResourceDoc> };

/** Whether a resource serves a standard verb. A `serves` declaration lists
 *  the routes the server answers; absent means all five. */
const servesVerb = (
  entry: AdminApiResource,
  verb: "create" | "delete" | "get" | "list" | "update",
): boolean => entry.serves === undefined || entry.serves[verb] === true;

/** One resource's describe document, read off the table. */
export const describeResource = (entry: AdminApiResource): ResourceDoc => {
  const children: Record<string, AdminApiChild> = entry.children ?? {};
  const custom: Record<string, AdminApiCustomRoute> = entry.custom ?? {};
  const verbs: ResourceDoc["verbs"] = {};
  if (servesVerb(entry, "create")) {
    verbs.create = { body: bodyDoc(entry.createBodySchema) };
  }
  if (servesVerb(entry, "delete")) {
    verbs.delete = { body: bodyDoc(DeleteBodySchema) };
  }
  if (servesVerb(entry, "get")) verbs.get = {};
  if (servesVerb(entry, "list")) verbs.list = {};
  if (servesVerb(entry, "update")) {
    verbs.update = { body: bodyDoc(entry.updateBodySchema) };
  }
  return {
    children: Object.fromEntries(
      Object.entries(children).map(([key, child]) => [
        key,
        {
          idParam: child.idParam,
          path: child.path,
          verbs: {
            create: { body: bodyDoc(child.bodySchema) },
            delete: { body: bodyDoc(DeleteBodySchema) },
            update: { body: bodyDoc(child.bodySchema) },
          },
        },
      ]),
    ),
    customRoutes: Object.fromEntries(
      Object.entries(custom).map(([key, route]) => [
        key,
        { method: route.method, subpath: route.subpath },
      ]),
    ),
    idParam: adminApiIdParam(entry.label),
    label: entry.label,
    path: entry.path,
    verbs,
  };
};

/** The describe document for the resources one describe command names, read
 *  off the table. */
export const describeEntries = (
  entries: readonly [string, AdminApiResource][],
): DescribeDoc => ({
  resources: Object.fromEntries(
    entries.map(([name, entry]) => [name, describeResource(entry)]),
  ),
});
