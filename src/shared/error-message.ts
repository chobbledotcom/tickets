/**
 * The human-readable message for a caught value.
 *
 * `catch` hands back `unknown`: a real `Error` carries a `.message`, but a
 * thrown string, number, or object does not. This reads the message when there
 * is one and falls back to the value's string form otherwise, so a log line
 * always has something useful to show.
 */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
