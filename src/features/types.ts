/**
 * Shared types for route handlers
 */

/** Signature for path and method dispatch functions. Returns null to delegate. */
export type PathMethodRoute = (
  request: Request,
  path: string,
  method: string,
) => Promise<Response | null>;
