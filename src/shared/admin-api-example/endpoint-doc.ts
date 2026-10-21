/**
 * The pieces every documented endpoint is built from: what a documented
 * endpoint looks like, and how its example bodies are written out.
 */

import {
  type AdminApiCustomRoute,
  type AdminApiResource,
  adminApiIdParam,
} from "#shared/admin-api-resources.ts";

export type EndpointDoc = {
  method: string;
  path: string;
  description: string;
  request?: string;
  response: string;
};

/** Example bodies are read on a page, so they stay indented. */
export const json = (data: unknown): string => JSON.stringify(data, null, 2);

/** The documented path of one resource's custom route. The path and the
 *  segment come from the resource table, so the docs cannot disagree with
 *  the server about them. */
export const customRoutePath = <
  E extends AdminApiResource & {
    custom: Record<string, AdminApiCustomRoute>;
  },
>(
  entry: E,
  customKey: Extract<keyof E["custom"], string>,
): string => {
  const custom = entry.custom[customKey];
  if (!custom) {
    throw new Error(`no custom route ${String(customKey)} is declared`);
  }
  return `/api/admin/${entry.path}/${custom.subpath}`;
};

/** The five standard admin-CRUD doc entries for a resource. The paths and the
 *  id param come from the resource table, so the docs cannot disagree with
 *  the server about them. Descriptions are passed in, because they carry
 *  per-resource wording such as the holiday's owner-only note. `desc` is
 *  [list, get, create, update, delete]. */
export const crudDocs = (c: {
  singular: string;
  entry: AdminApiResource;
  example: unknown;
  listResponse: unknown;
  createBody: unknown;
  updateBody: unknown;
  deleteBody: unknown;
  desc: [string, string, string, string, string];
  /** Fields a brand-new record always has, whatever the caller sent — the
   * running totals that only bookings can move. */
  freshRecord?: Record<string, number>;
  /** What the stored defaults give a new record where the create body is
   * silent, for fields whose default differs from the example record. */
  newRecordDefaults?: Record<string, unknown>;
}): EndpointDoc[] => {
  const base = `/api/admin/${c.entry.path}`;
  const byId = `${base}/:${adminApiIdParam(c.entry.label)}`;
  const answerWith = (...changes: unknown[]): string =>
    json({ [c.singular]: Object.assign({}, c.example, ...changes) });
  const one = answerWith();
  // An update answers with the record as it now reads. A create answers with
  // the record as just stored: what the caller sent, over the defaults, with
  // nothing yet booked against it.
  const updated = answerWith(c.updateBody);
  const created = answerWith(
    c.newRecordDefaults ?? {},
    c.createBody,
    c.freshRecord ?? {},
  );
  const [list, get, create, update, del] = c.desc;
  return [
    {
      description: list,
      method: "GET",
      path: base,
      response: json(c.listResponse),
    },
    { description: get, method: "GET", path: byId, response: one },
    {
      description: create,
      method: "POST",
      path: base,
      request: json(c.createBody),
      response: created,
    },
    {
      description: update,
      method: "PUT",
      path: byId,
      request: json(c.updateBody),
      response: updated,
    },
    {
      description: del,
      method: "DELETE",
      path: byId,
      request: json(c.deleteBody),
      response: json({ status: "ok" }),
    },
  ];
};
