/**
 * The pieces every documented endpoint is built from: what a documented
 * endpoint looks like, and how its example bodies are written out.
 */

import type * as v from "valibot";
import {
  type AdminApiChild,
  type AdminApiResource,
  adminApiIdParam,
} from "#shared/admin-api-resources.ts";
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
  /** The fields the request body takes. Absent on a route with no body and
   *  on one whose body the server reads by hand. */
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
  const [create, update, del] = c.desc;
  return [
    writeDoc("POST", base, create, fields, c.createBody, json(c.created)),
    writeDoc("PUT", byId, update, fields, c.updateBody, json(c.updated)),
    deleteDoc(byId, del, c.deleteBody),
  ];
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

/** The field rows of one resource. Its declared field list gives them, with
 *  the body keys the list does not declare. Otherwise the two body schemas
 *  in the resource table give them. */
const resourceFieldDocs = (entry: AdminApiResource): FieldDocs => {
  const declared = DECLARED_FIELDS[entry.path];
  if (declared !== undefined) {
    return specFieldDocs(declared.fields, declared.extras);
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
 *  Descriptions are passed in, because they carry per-resource wording such
 *  as the holiday's owner-only note. `desc` is [list, get, create, update,
 *  delete]. */
export const crudDocs = (c: {
  entry: AdminApiResource;
  example: unknown;
  createBody: unknown;
  updateBody: unknown;
  deleteBody: unknown;
  desc: [string, string, string, string, string];
  /** The list answer. The default is the example in the resource's own
   *  collection envelope. A resource whose list answers more than its rows
   *  passes its own. */
  listResponse?: Record<string, unknown>;
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
}): EndpointDoc[] => {
  const base = `/api/admin/${c.entry.path}`;
  const byId = `${base}/:${adminApiIdParam(c.entry.label)}`;
  const singular = c.entry.label.toLowerCase();
  const listResponse = c.listResponse ?? { [c.entry.path]: [c.example] };
  const answerWith = (...changes: unknown[]): string =>
    json({ [singular]: Object.assign({}, c.example, ...changes) });
  const one = answerWith();
  // An update answers with the record as it now reads. A create answers with
  // the record as just stored: what the caller sent, over the defaults, with
  // nothing yet booked against it.
  const updated = answerWith(c.updateBody);
  const created =
    c.createResponse === undefined
      ? answerWith(c.newRecordDefaults ?? {}, c.createBody, c.freshRecord ?? {})
      : json({ [singular]: c.createResponse });
  const fields = resourceFieldDocs(c.entry);
  const [list, get, create, update, del] = c.desc;
  return [
    {
      description: list,
      method: "GET",
      path: base,
      response: json(listResponse),
    },
    { description: get, method: "GET", path: byId, response: one },
    writeDoc("POST", base, create, fields.create, c.createBody, created),
    writeDoc("PUT", byId, update, fields.update, c.updateBody, updated),
    deleteDoc(byId, del, c.deleteBody),
  ];
};
