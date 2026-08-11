/**
 * Read a request's JSON body once, in one place.
 *
 * A malformed JSON body is an expected boundary condition (a bad client), so
 * this reports success/failure as a flag rather than throwing — the caller
 * turns a failure into whatever error response its surface needs (an API 400, a
 * form 400), keeping this response-agnostic.
 */
import { readJson } from "#shared/read-json.ts";

export const readJsonBody = async (
  request: Request,
): ReturnType<typeof readJson> => await readJson(() => request.json());
