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
import {
  apiEntityGate,
  type RequiredTextReader,
  type RowBodyHandler,
} from "#shared/rest/crud-parsers.ts";

/** The write routes one child surface answers. */
export type ApiChildSurface<Parent, Child extends { id: number }> = {
  /** The parent-then-child load for an update or a delete. It answers 404
   *  for an unknown parent or a child of another parent. */
  child: (
    request: Request,
    params: RouteParams,
    handler: RowBodyHandler<{ child: Child; parent: Parent }>,
  ) => Promise<Response>;
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
  const child: ApiChildSurface<Parent, Child>["child"] = (
    request,
    params,
    handler,
  ) =>
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
    child,
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
