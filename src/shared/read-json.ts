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

/** Parse JSON text, and let the caller decide what a torn text becomes. */
export const parseJsonWith =
  (onParseError: (error: unknown) => unknown) =>
  (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch (error) {
      return onParseError(error);
    }
  };

/** Parse text as JSON. Null is the documented answer for text that is not
 * JSON: the caller's schema check then refuses it like any other bad shape. */
export const parseJsonOrNull = parseJsonWith(() => null);
