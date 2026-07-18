import { processRequest } from "#routes/app/request.ts";
import { requestScopedHandler } from "#routes/request-scopes.ts";

/** Handle one request inside every request-scoped store. */
export const handleRequest = requestScopedHandler(processRequest);
