/** A pure-listed module that reaches the clock root. */
import { clock } from "#test/scripts/check-effects/fixtures/clock.ts";

export const timed = (): number => clock();
