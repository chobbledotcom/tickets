// effects: pure
/** Rules about the Content-Type of a request. They read the request and the
 *  path only. */

/** The request Content-Type header in lower case. Header values are not case
 *  sensitive, so every caller compares the same form. */
export const lowerContentType = (request: Request): string =>
  (request.headers.get("content-type") ?? "").toLowerCase();

/** Webhook paths that accept JSON. */
const isWebhookPath = (path: string): boolean =>
  path === "/payment/webhook" || path === "/sms/webhook";

/** Scan paths. The scanner posts JSON check-ins, reads its offline ticket
 * cache as JSON, and asks its name search for JSON. */
const SCAN_API_PATTERN =
  /^\/admin\/(listing|groups)\/\d+\/scan(?:-cache|-search)?$/;

/** Public API paths. */
const API_PATH_PATTERN = /^\/api\//;

/** Apple Wallet web service paths (PassKit protocol). */
const WALLET_WEBSERVICE_PATTERN = /^\/v1\//;

/** Whether the path is a JSON API endpoint. The patterns live here so the
 *  always-loaded middleware never loads route modules for a regex. */
export const isJsonApiPath = (path: string): boolean =>
  SCAN_API_PATTERN.test(path) ||
  API_PATH_PATTERN.test(path) ||
  WALLET_WEBSERVICE_PATTERN.test(path);

/** Whether the Content-Type of the request is right for the path. A request
 *  that is not a POST is always valid. A webhook or JSON API POST needs
 *  application/json. Any other POST needs a form type or multipart. */
export const isValidContentType = (request: Request, path: string): boolean => {
  if (request.method !== "POST") {
    return true;
  }
  // This endpoint has no body and uses a bearer key, so CSRF does not apply.
  if (path === "/instance/site-credentials") {
    return true;
  }
  const contentType = lowerContentType(request);

  if (isWebhookPath(path) || isJsonApiPath(path)) {
    return contentType.startsWith("application/json");
  }

  return (
    contentType.startsWith("application/x-www-form-urlencoded") ||
    contentType.startsWith("multipart/form-data")
  );
};

const BUFFERED_POST_CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "application/json",
] as const;

/** Whether the body of this request must be read before any asynchronous
 *  setup. */
export const shouldBufferRequestBody = (request: Request): boolean => {
  if (request.method !== "POST") return false;
  const contentType = lowerContentType(request);
  return BUFFERED_POST_CONTENT_TYPES.some((type) =>
    contentType.startsWith(type),
  );
};
