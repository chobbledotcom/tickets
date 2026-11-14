/**
 * One child surface's write routes, on the attribute-options and answers
 * pattern. The gate loads the parent row. It then picks one child by the id
 * params the routes carry. The two route builders give a resource its child
 * update and delete handlers. The resource spells only its own write and
 * log calls.
 */

import { byId } from "#fp";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import type { AuthPolicy } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn, RouteParams } from "#routes/router.ts";
import type { CrudChildHandlers } from "#shared/rest/crud-api-types.ts";
import {
  apiEntityGate,
  type RequiredTextReader,
  type RowBodyHandler,
} from "#shared/rest/crud-parsers.ts";
import type { RecordSurface } from "#shared/rest/record.ts";
import { recordJsonPolicy } from "#shared/rest/record-api.ts";

/** The write routes one child surface answers. */
export type ApiChildSurface<Parent, Child extends { id: number }> = {
  /** One child row's confirmed-delete route. The confirmation must match
   *  the child's display text. The delete answers the shared plain ok. */
  confirmedDelete: (
    textOf: (child: Child) => string,
    label: string,
    destroy: (parent: Parent, child: Child) => Promise<void>,
  ) => RouteHandlerFn;
  /** The parent gate a child create runs through. The parent read pins to
   *  the primary. A lagging replica cannot miss the row the create made. */
  parent: (
    request: Request,
    params: RouteParams,
    handler: RowBodyHandler<Parent>,
  ) => Promise<Response>;
  /** One child row's text-update route. The reader parses the body's text.
   *  The write renames the child with its own log. The answer carries the
   *  parent envelope. */
  textUpdate: (
    reader: RequiredTextReader,
    write: (parent: Parent, child: Child, text: string) => Promise<Response>,
  ) => RouteHandlerFn;
};

/**
 * One child surface's write routes. The `lookup` is the primary-pinned
 * parent read. `childrenOf` lists the parent's children in display order.
 * The labels name the parent and the child in their not-found answers. The
 * id params are the route segments the write routes read.
 */
export const apiChildSurface = <Parent, Child extends { id: number }>(config: {
  childIdParam: string;
  childLabel: string;
  childrenOf: (parent: Parent) => readonly Child[];
  lookup: (id: number) => Promise<Parent | null>;
  parentIdParam: string;
  parentLabel: string;
  policy: AuthPolicy<"json">;
}): ApiChildSurface<Parent, Child> => {
  const gate = apiEntityGate(config.lookup, config.parentLabel, config.policy);
  const parent: ApiChildSurface<Parent, Child>["parent"] = (
    request,
    params,
    handler,
  ) => gate(request, params[config.parentIdParam] as number, handler);
  const child = (
    request: Request,
    params: RouteParams,
    handler: RowBodyHandler<{ child: Child; parent: Parent }>,
  ): Promise<Response> =>
    parent(request, params, (row, body) => {
      const childId = params[config.childIdParam] as number;
      const childRow = byId(config.childrenOf(row)).get(childId);
      if (!childRow) {
        return Promise.resolve(
          apiErrorResponse(`${config.childLabel} not found`, 404),
        );
      }
      return handler({ child: childRow, parent: row }, body);
    });
  return {
    confirmedDelete: (textOf, label, destroy) => (request, params) =>
      child(request, params, async ({ child: gone, parent }, body) => {
        const error = verifyIdentifierOrJsonError(
          textOf(gone),
          body.confirm_identifier,
          label,
        );
        if (error) return apiErrorResponse(error);
        await destroy(parent, gone);
        return jsonResponse({ status: "ok" });
      }),
    parent,
    textUpdate: (reader, write) => (request, params) =>
      child(request, params, ({ child: renamed, parent }, body) =>
        reader(body, (text) => write(parent, renamed, text)),
      ),
  };
};

/** The three write routes every text-named child surface shares: create under
 *  the parent, rename one child, and delete one child by its text. */
export const childTextHandlers = <
  Parent,
  Child extends { id: number },
>(config: {
  create: (parent: Parent, text: string) => Promise<Response>;
  destroy: (parent: Parent, child: Child) => Promise<void>;
  label: string;
  reader: RequiredTextReader;
  surface: ApiChildSurface<Parent, Child>;
  textOf: (child: Child) => string;
  update: (parent: Parent, child: Child, text: string) => Promise<Response>;
}): CrudChildHandlers => ({
  create: (request, params) =>
    config.surface.parent(request, params, (parent, body) =>
      config.reader(body, (text) => config.create(parent, text)),
    ),
  delete: config.surface.confirmedDelete(
    config.textOf,
    config.label,
    (parent, child) => config.destroy(parent, child),
  ),
  update: config.surface.textUpdate(config.reader, (parent, child, text) =>
    config.update(parent, child, text),
  ),
});

/** One text-named child's domain writes and its parent response. */
type TextChildWrites<Parent, Child extends { id: number }> = {
  add: (parent: Parent, text: string) => Promise<unknown>;
  remove: (parent: Parent, child: Child) => Promise<unknown>;
  rename: (parent: Parent, child: Child, text: string) => Promise<unknown>;
  respond: (parentId: number, status?: number) => Promise<Response>;
  /** A refusal that depends on the parent, before the add. */
  refuseAdd?: (parent: Parent) => Response | null;
};

/** Build a text-named child's three routes from its domain writes. */
export const childTextConfig = <
  Parent extends { id: number },
  Child extends { id: number },
>(
  surface: ApiChildSurface<Parent, Child>,
  label: string,
  reader: RequiredTextReader,
  textOf: (child: Child) => string,
  writes: TextChildWrites<Parent, Child>,
): CrudChildHandlers =>
  childTextHandlers({
    create: async (parent, text) => {
      const refusal = writes.refuseAdd?.(parent);
      if (refusal) return refusal;
      await writes.add(parent, text);
      return writes.respond(parent.id, 201);
    },
    destroy: async (parent, child) => {
      await writes.remove(parent, child);
    },
    label,
    reader,
    surface,
    textOf,
    update: async (parent, child, text) => {
      await writes.rename(parent, child, text);
      return writes.respond(parent.id);
    },
  });

/** One child surface whose audience is the parent record's page audience. */
export const recordChildSurface = <Parent, Child extends { id: number }>(
  record: RecordSurface,
  parentIdParam: string,
  parentLabel: string,
  childIdParam: string,
  childLabel: string,
  lookup: (id: number) => Promise<Parent | null>,
  childrenOf: (parent: Parent) => readonly Child[],
): ApiChildSurface<Parent, Child> =>
  apiChildSurface({
    childIdParam,
    childLabel,
    childrenOf,
    lookup,
    parentIdParam,
    parentLabel,
    policy: recordJsonPolicy(record),
  });
