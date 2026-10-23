/** A pure-listed module that reaches the clock root. */
import { clock } from "../clock.ts";

export const timed = (): number => clock();
