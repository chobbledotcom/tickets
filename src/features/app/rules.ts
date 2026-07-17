import { getCleanUrl, lowerContentType } from "#routes/middleware.ts";
import {
  emptyCustomCssResponse,
  isCssResponse,
} from "#routes/public/custom-css.ts";
import {
  bufferRequestBody,
  type RequestTransform,
} from "#routes/request-body.ts";

const CUSTOM_CSS_PATH = "/custom.css";

const BUFFERED_POST_CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "application/json",
] as const;

/** Whether this request body must be captured before any asynchronous setup. */
export const shouldBufferRequestBody = (request: Request): boolean => {
  if (request.method !== "POST") return false;
  const contentType = lowerContentType(request);
  return BUFFERED_POST_CONTENT_TYPES.some((type) =>
    contentType.startsWith(type),
  );
};

/** Buffer request bodies that handlers read after asynchronous setup. */
export const bufferRequestIfNeeded: RequestTransform = (request) =>
  shouldBufferRequestBody(request)
    ? bufferRequestBody(request)
    : Promise.resolve(request);

/** Whether this request should record SQL for the admin debug footer. */
export const shouldLogQueries = (method: string, prefix: string): boolean =>
  method === "GET" && prefix === "admin";

/** Whether routine background pruning is safe during this request. */
export const shouldRunPrunes = (method: string, path: string): boolean =>
  method !== "POST" || path !== "/admin/privacy/orphans";

/** Whether a busy-database page may retry the request automatically. */
export const shouldRetryBusyRequest = (method: string): boolean =>
  method === "GET" || method === "HEAD";

/** A clean location for a tracked GET URL, or null when no redirect is needed. */
export const trackingRedirectLocation = (
  url: URL,
  method: string,
): string | null => (method === "GET" ? getCleanUrl(url) : null);

/** Setup owns its root path and every path below it. */
export const isSetupPath = (path: string): boolean =>
  path === "/setup" || path.startsWith("/setup/");

/** Whether the settings-version read may start before database setup. */
export const shouldPrefetchSettings = (path: string): boolean =>
  !isSetupPath(path);

const isRedirectResponse = (response: Response): boolean =>
  response.status >= 300 && response.status < 400;

/** Never return an HTML system page where the browser expects custom CSS. */
export const ensureCustomCssResponse = (
  path: string,
  response: Response,
): Response =>
  path === CUSTOM_CSS_PATH &&
  !isRedirectResponse(response) &&
  !isCssResponse(response)
    ? emptyCustomCssResponse()
    : response;
