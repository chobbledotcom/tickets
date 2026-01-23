/**
 * Ticket Reservation System - Bun Server
 *
 * This file re-exports from the routes module for backward compatibility.
 * New code should import directly from #routes.
 */

export type { ServerContext } from "#routes";
export {
  getSecurityHeaders,
  handleRequest,
  isEmbeddablePath,
  isValidContentType,
  isValidDomain,
  isValidOrigin,
} from "#routes";
