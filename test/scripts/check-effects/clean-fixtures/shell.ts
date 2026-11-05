/** An unmarked module that reads the clock. The check ignores it. */
import { now } from "./clock.ts";

export const stamp = (): number => now();
