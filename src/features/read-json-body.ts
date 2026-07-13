/**
 * Read a request's JSON body once, in one place.
 *
 * A malformed JSON body is an expected boundary condition (a bad client), so
 * this reports success/failure as a flag rather than throwing — the caller
 * turns a failure into whatever error response its surface needs (an API 400, a
 * form 400), keeping this response-agnostic.
 */
export const readJsonBody = async (
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> => {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
};
