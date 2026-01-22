/**
 * Shared types for route handlers
 */

/**
 * Server context for accessing connection info
 */
export type ServerContext = {
  requestIP?: (req: Request) => { address: string } | null;
};
