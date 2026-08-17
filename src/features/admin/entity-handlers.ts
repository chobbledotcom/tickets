/**
 * Entity loading patterns for admin route handlers
 */

import { withEntity } from "#routes/entity.ts";
import { notFoundResponse } from "#routes/response.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";

/** Wraps a loader so a route can pass its params first, then its handler. */
export const withEntityLoader =
  <T, P extends unknown[]>(load: (...args: P) => Promise<T | null>) =>
  (...args: P) =>
  (handler: ResponseHandler<[entity: T]>): Promise<Response> =>
    withEntity(handler)(() => load(...args));

/**
 * Generic wrapper for typed route params: parse param as number, load entity,
 * return 404 if missing, otherwise call handler.
 */
export const withEntityFromParam = <T>(
  paramValue: string | number | undefined,
  load: (id: number) => Promise<T | null>,
  handler: ResponseHandler<[entity: T]>,
): Promise<Response> => {
  const id =
    typeof paramValue === "string"
      ? Number.parseInt(paramValue, 10)
      : paramValue;
  if (id === undefined || Number.isNaN(id)) {
    return Promise.resolve(notFoundResponse());
  }
  return withEntity(handler)(() => load(id!));
};
