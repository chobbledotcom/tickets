/**
 * REST module - unified CRUD operations for HTTP routes
 *
 * Provides:
 * - defineResource: Tie table definitions to form fields
 * - Handler factories: Create typed route handlers with auth/CSRF
 *
 * Example:
 *   import { defineResource, createHandler } from '#lib/rest';
 *
 *   const eventsResource = defineResource({
 *     table: eventsTable,
 *     fields: eventFields,
 *     toInput: extractEventInput,
 *   });
 *
 *   // Use with routes
 *   const handleCreate = createHandler(eventsResource, {...});
 */

// Handler factories
export {
  type CreateHandlerOptions,
  createHandler,
  type DeleteHandlerOptions,
  deleteHandler,
  type UpdateHandlerOptions,
} from "./handlers.ts";

// Resource definition
export {
  type CreateResult,
  type DeleteResult,
  defineResource,
  type ParseResult,
  type Resource,
  type ResourceConfig,
  type UpdateResult,
} from "./resource.ts";
