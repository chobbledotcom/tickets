/**
 * The pieces every documented endpoint is built from: what a documented
 * endpoint looks like, and how its example bodies are written out.
 */

import type * as v from "valibot";
import { resourceFeature } from "#shared/admin-api-resource-features.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiChild,
  type AdminApiResource,
  type AdminApiResourceName,
  adminApiIdParam,
} from "#shared/admin-api-resources.ts";
import type { EnabledFeatures } from "#shared/admin-features.ts";
import { withoutKeys } from "#shared/fp-records.ts";
import {
  apiClosedFields,
  closedFields,
  featureClosedKeys,
  type WriteAccess,
} from "#shared/rest/field-specs.ts";
import { DECLARED_FIELDS } from "./declared-fields.ts";
import {
  type FieldDocRow,
  type FieldDocs,
  schemaRows,
  specFieldDocs,
} from "./field-docs.ts";

export type EndpointDoc = {
  method: string;
  path: string;
  description: string;
  /** The fields the request body takes. Absent on a route with no body. */
  fields?: readonly FieldDocRow[];
  request?: string;
  response: string;
};

/** Example bodies are read on a page, so they stay indented. */
export const json = (data: unknown): string => JSON.stringify(data, null, 2);

/** One item's text renamed when it equals `from`, unchanged otherwise — the
 *  "after a rename" example bodies, which keep every other field. */
const renameOneText = <Item extends { text: string }>(
  items: readonly Item[],
  from: string,
  to: string,
): Item[] =>
  items.map((item) => ({ ...item, text: item.text === from ? to : item.text }));

/** One child surface: its resource in the resource table, and its key
 *  among the children of that resource. */
type ChildRef<Children> = readonly [
  entry: AdminApiResource & { children: Children },
  childKey: keyof Children & string,
];

/** The documented base path of one child write route: the parent's id param
 *  and the child segment both come from the resource table. */
export const childDocBase = <Children extends Record<string, AdminApiChild>>(
  ...[entry, childKey]: ChildRef<Children>
): string => {
  const child = entry.children[childKey];
  return `/api/admin/${entry.path}/:${adminApiIdParam(entry.label)}/${child.path}`;
};

/** One documented write that carries a body and names the body's fields. */
const writeDoc = (
  method: "POST" | "PUT",
  path: string,
  description: string,
  fields: readonly FieldDocRow[],
  body: unknown,
  response: string,
): EndpointDoc => ({
  description,
  fields,
  method,
  path,
  request: json(body),
  response,
});

/** One documented delete: the confirmation in, a plain ok out. */
const deleteDoc = (
  path: string,
  description: string,
  body: unknown,
): EndpointDoc => ({
  description,
  method: "DELETE",
  path,
  request: json(body),
  response: json({ status: "ok" }),
});

/** The three write entries of one surface: create, update, delete. Each
 *  list names its parts in that order. */
const writeDocs = (
  [base, byId]: [string, string],
  [create, update, del]: [string, string, string],
  fields: FieldDocs,
  [createBody, updateBody, deleteBody]: [unknown, unknown, unknown],
  [created, updated]: [string, string],
): EndpointDoc[] => [
  writeDoc("POST", base, create, fields.create, createBody, created),
  writeDoc("PUT", byId, update, fields.update, updateBody, updated),
  deleteDoc(byId, del, deleteBody),
];

/** A child surface whose write body the resource table declares. */
type ChildWithBody = AdminApiChild & { bodySchema: v.GenericSchema };

/** The three write entries of one child surface: add, change, delete. The
 *  paths and the body fields come from the resource table. One body schema
 *  serves the add and the change. `created` and `updated` are the whole
 *  answers. `desc` is [create, update, delete]. */
export const childWriteDocs = <Children extends Record<string, ChildWithBody>>(
  [entry, childKey]: ChildRef<Children>,
  c: {
    createBody: unknown;
    created: unknown;
    deleteBody: unknown;
    desc: [string, string, string];
    updateBody: unknown;
    updated: unknown;
  },
): EndpointDoc[] => {
  const child = entry.children[childKey];
  const base = childDocBase(entry, childKey);
  const byId = `${base}/:${child.idParam}`;
  const fields = schemaRows(child.bodySchema);
  return writeDocs(
    [base, byId],
    c.desc,
    { create: fields, update: fields },
    [c.createBody, c.updateBody, c.deleteBody],
    [json(c.created), json(c.updated)],
  );
};

/** The three write entries of a list of choices under a record: the options
 *  of an attribute, or the answers of a question. The record holds the list
 *  under the child key. The add puts `added` last. The rename changes one
 *  text, and the delete confirms the text as it was. */
export const choiceWriteDocs = <
  Children extends Record<string, ChildWithBody>,
  Choice extends { text: string },
>(
  [entry, childKey]: ChildRef<Children>,
  c: {
    added: Choice;
    desc: [string, string, string];
    record: Record<keyof Children & string, readonly Choice[]> &
      Record<string, unknown>;
    rename: readonly [from: string, to: string];
  },
): EndpointDoc[] => {
  const [from, to] = c.rename;
  const choices = c.record[childKey];
  const answerWith = (list: readonly Choice[]) => ({
    [entry.label.toLowerCase()]: { ...c.record, [childKey]: list },
  });
  return childWriteDocs([entry, childKey], {
    createBody: { text: c.added.text },
    created: answerWith([...choices, c.added]),
    deleteBody: { confirm_identifier: from },
    desc: c.desc,
    updateBody: { text: to },
    updated: answerWith(renameOneText(choices, from, to)),
  });
};

/** The keys of one resource that the docs leave out for one viewer. The
 *  viewer cannot set a `closed` key. An answer leaves out a `hidden` key,
 *  because its feature is off. */
export type DocKeys = {
  closed: ReadonlySet<string>;
  hidden: ReadonlySet<string>;
};

const NO_KEYS: DocKeys = { closed: new Set(), hidden: new Set() };

/** The keys the docs of one resource leave out. The rules are the access
 *  rules that the server reads, so the docs show what a write accepts. A
 *  resource with no declared field list closes no key. */
export const docKeysOf = (
  entry: AdminApiResource,
  access: WriteAccess | undefined,
): DocKeys => {
  const declared = DECLARED_FIELDS[entry.path];
  if (declared === undefined) return NO_KEYS;
  if (access === undefined) {
    throw new Error(
      `${entry.label} declares its fields, so its docs need the access of the viewer`,
    );
  }
  return {
    closed: new Set(
      apiClosedFields(closedFields(declared.access, access)).keys(),
    ),
    hidden: new Set(featureClosedKeys(declared.access, access.features)),
  };
};

/** The field rows of one resource. Its declared field list gives them, with
 *  the body keys the list does not declare. Otherwise the two body schemas
 *  in the resource table give them. */
const resourceFieldDocs = (
  entry: AdminApiResource,
  closed: ReadonlySet<string>,
): FieldDocs => {
  const declared = DECLARED_FIELDS[entry.path];
  if (declared !== undefined) {
    return specFieldDocs(declared.fields, declared.extras, closed);
  }
  const { createBodySchema, updateBodySchema } = entry;
  if (createBodySchema === undefined || updateBodySchema === undefined) {
    throw new Error(
      `${entry.label} has no declared field list and no body schemas`,
    );
  }
  return {
    create: schemaRows(createBodySchema),
    update: schemaRows(updateBodySchema),
  };
};

/** The five standard admin-CRUD doc entries for a resource. The paths, the
 *  id param, the two envelope keys, and the body fields come from the
 *  resource table. The docs therefore cannot disagree with the server.
 *  `access` is the write access of the viewer. A resource with a declared
 *  field list needs it. The docs leave out each key that the viewer cannot
 *  set. They also leave out each answer key whose feature is off.
 *  Descriptions are passed in, because they carry per-resource wording such
 *  as the holiday's owner-only note. `desc` is [list, get, create, update,
 *  delete]. */
/** What the docs of one resource are built from. */
export type CrudDocsParts = {
  entry: AdminApiResource;
  example: object;
  createBody: object;
  updateBody: object;
  deleteBody: unknown;
  desc: [string, string, string, string, string];
  /** What the list answers beside its rows. */
  listExtras?: Record<string, unknown>;
  /** Fields a brand-new record always has, whatever the caller sent — the
   * running totals that only bookings can move. */
  freshRecord?: Record<string, number>;
  /** The record a create answers with. The default merges the create body over
   *  the example, which is right when every body field is a stored field. A
   *  body that carries something else — a file's bytes, for one — passes its
   *  own answer. */
  createResponse?: Record<string, unknown>;
  /** What the stored defaults give a new record where the create body is
   * silent, for fields whose default differs from the example record. */
  newRecordDefaults?: Record<string, unknown>;
};

export const crudDocsFor =
  (access?: WriteAccess) =>
  (c: CrudDocsParts): EndpointDoc[] => {
    const base = `/api/admin/${c.entry.path}`;
    const byId = `${base}/:${adminApiIdParam(c.entry.label)}`;
    const singular = c.entry.label.toLowerCase();
    const { closed, hidden } = docKeysOf(c.entry, access);
    const example = withoutKeys(hidden)(c.example);
    const openOf = withoutKeys(closed);
    const createBody = openOf(c.createBody);
    const updateBody = openOf(c.updateBody);
    const listResponse = { ...c.listExtras, [c.entry.path]: [example] };
    const answerWith = (...changes: unknown[]): string =>
      json({ [singular]: Object.assign({}, example, ...changes) });
    const one = answerWith();
    // An update answers with the record as it now reads. A create answers with
    // the record as just stored: what the caller sent, over the defaults, with
    // nothing yet booked against it.
    const updated = answerWith(updateBody);
    const created =
      c.createResponse === undefined
        ? answerWith(c.newRecordDefaults ?? {}, createBody, c.freshRecord ?? {})
        : json({ [singular]: c.createResponse });
    const fields = resourceFieldDocs(c.entry, closed);
    const [list, get, create, update, del] = c.desc;
    return [
      {
        description: list,
        method: "GET",
        path: base,
        response: json(listResponse),
      },
      { description: get, method: "GET", path: byId, response: one },
      ...writeDocs(
        [base, byId],
        [create, update, del],
        fields,
        [createBody, updateBody, c.deleteBody],
        [created, updated],
      ),
    ];
  };

/** The doc entries of a resource with no declared field list. Such a
 *  resource closes no key, so its docs need no viewer. */
export const crudDocs = crudDocsFor();

/** Who can call the routes of a record: every admin, or the owner alone. */
type RecordCallers = "owner" | "staff";

/** The five route descriptions of a record that needs no words of its own.
 *  `one` is the record with its article, such as "a holiday". */
const recordDesc = (
  one: string,
  many: string,
  callers: RecordCallers,
): CrudDocsParts["desc"] => {
  const [note, lead] =
    callers === "owner" ? [" (owner only)", "owner only, "] : ["", ""];
  return [
    `List all ${many}${note}`,
    `Get ${one} by ID${note}`,
    `Create ${one}${note}`,
    `Update ${one} (${lead}all fields optional)`,
    `Delete ${one} (${lead}requires name confirmation)`,
  ];
};

/** The doc entries of a record whose route descriptions follow the common
 *  wording. The resource table gives the record by its path. */
export const recordDocsFor =
  (access: WriteAccess) =>
  (
    path: AdminApiResourceName,
    one: string,
    parts: Omit<CrudDocsParts, "desc" | "entry">,
    callers: RecordCallers = "staff",
  ): EndpointDoc[] =>
    crudDocsFor(access)({
      ...parts,
      desc: recordDesc(one, path.replaceAll("-", " "), callers),
      entry: ADMIN_API_RESOURCES[path],
    });

/** One viewer's view of the docs: what the viewer can write on this site,
 *  and the admin features that are on. */
export type DocsView = {
  access: WriteAccess;
  features: EnabledFeatures;
};

/** Keeps the docs of a resource while its feature is on. A resource of no
 *  feature always keeps its docs. */
export const shownFor =
  (view: DocsView) =>
  (entry: AdminApiResource, docs: EndpointDoc[]): EndpointDoc[] => {
    const feature = resourceFeature(entry.path);
    return feature === undefined || view.features[feature] ? docs : [];
  };
