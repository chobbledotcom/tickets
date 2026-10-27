/**
 * Read a request's JSON body once, in one place.
 *
 * A malformed JSON body is an expected boundary condition (a bad client).
 * This reports success or failure as a flag rather than throwing. The caller
 * turns a failure into whatever error response its surface needs (an API 400,
 * a form 400). This keeps the helper response-agnostic.
 */
import { readJson } from "#shared/read-json.ts";

export const readJsonBody = async (
  request: Request,
): ReturnType<typeof readJson> => await readJson(() => request.json());
