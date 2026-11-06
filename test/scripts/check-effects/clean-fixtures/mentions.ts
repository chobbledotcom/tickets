/** Names the marker inside a comment line, which does not mark it.
 * // effects: pure */
import { now } from "./clock.ts";

export const later = (): number => now() + 1;
