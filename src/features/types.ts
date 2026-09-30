/**
 * Shared types for route handlers
 */

/** Signature for path/method dispatch functions; returns null to delegate. */
export type PathMethodRoute = (
  request: Request,
  path: string,
  method: string,
) => Promise<Response | null>;
