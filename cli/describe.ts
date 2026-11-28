/** The agent's describe document: every resource's verbs, bodies, children,
 *  and custom routes, read off the admin api table. */
import type * as v from "valibot";
import {
  type AdminApiChild,
  type AdminApiCustomRoute,
  type AdminApiResource,
  adminApiIdParam,
  adminApiServes,
  DeleteBodySchema,
} from "#shared/admin-api-resources.ts";
import { type SchemaShape, schemaShape } from "#shared/rest/schema-shape.ts";

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

/** The JSON type one shape names. An optional or nullable wrapper changes
 *  requiredness, not type. */
const typeOf = (shape: SchemaShape): string => {
  switch (shape.kind) {
    case "array":
      return "array";
    case "object":
      return "object";
    case "boolean":
    case "number":
    case "string":
      return shape.kind;
    case "nullable":
    case "optional":
      return typeOf(shape.of);
    case "picklist":
    case "unknown":
      return "unknown";
  }
};

/** Read one field's JSON type and nested shape off its schema shape. A shape
 *  the walker cannot name answers "unknown" rather than a guess. */
const fieldDoc = (
  name: string,
  shape: SchemaShape,
  required: boolean,
): FieldDoc => {
  if (shape.kind === "optional") {
    // An optional key a write may omit; a nullable key must travel, so its
    // requiredness stays as it is.
    return fieldDoc(name, shape.of, false);
  }
  if (shape.kind === "nullable") {
    return fieldDoc(name, shape.of, required);
  }
  if (shape.kind === "array") {
    return {
      items: { type: typeOf(shape.item) },
      name,
      required,
      type: "array",
    };
  }
  if (shape.kind === "object") {
    return { fields: fieldsOf(shape.entries), name, required, type: "object" };
  }
  return { name, required, type: typeOf(shape) };
};

const fieldsOf = (entries: Record<string, SchemaShape>): FieldDoc[] =>
  Object.entries(entries).map(([name, shape]) => fieldDoc(name, shape, true));

/** One verb's body document, read off the schema the table declares. A body
 *  schema the table carries must be an object schema; anything else is a
 *  table bug the CLI refuses. */
const bodyDoc = (schema: v.GenericSchema | undefined): BodyDoc => {
  if (!schema) return { kind: "server" };
  const shape = schemaShape(schema);
  if (shape.kind !== "object") {
    throw new Error(
      "a body schema in the admin api table must be an object schema",
    );
  }
  return { fields: fieldsOf(shape.entries), kind: "fields" };
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

/** One resource's describe document, read off the table. */
export const describeResource = (entry: AdminApiResource): ResourceDoc => {
  const children: Record<string, AdminApiChild> = entry.children ?? {};
  const custom: Record<string, AdminApiCustomRoute> = entry.custom ?? {};
  const verbs: ResourceDoc["verbs"] = {};
  if (adminApiServes(entry, "create")) {
    verbs.create = { body: bodyDoc(entry.createBodySchema) };
  }
  if (adminApiServes(entry, "delete")) {
    verbs.delete = { body: bodyDoc(DeleteBodySchema) };
  }
  if (adminApiServes(entry, "get")) verbs.get = {};
  if (adminApiServes(entry, "list")) verbs.list = {};
  if (adminApiServes(entry, "update")) {
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
