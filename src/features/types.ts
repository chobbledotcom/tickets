/**
 * Shared types for route handlers
 */

/**
 * Server context for accessing connection info
 */
export type ServerContext = {
  requestIP?: (req: Request) => { address: string } | null;
};

/** Signature for path/method dispatch functions; returns null to delegate. */
export type PathMethodRoute = (
  request: Request,
  path: string,
  method: string,
  server?: ServerContext,
) => Promise<Response | null>;
