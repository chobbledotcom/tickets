/** One attempt to obtain JSON at an external boundary. */
export type JsonRead = { ok: true; value: unknown } | { ok: false };

/** Read JSON without choosing the caller's failure response. HTTP routes and
 * provider transports give malformed input different public meanings, but the
 * boundary operation itself is one shared mechanism. */
export const readJson = async (
  read: () => unknown | Promise<unknown>,
): Promise<JsonRead> => {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
};
