/** A pure-listed module that reaches the database root through one
 * import hop. */
import { write } from "#test/scripts/check-effects/fixtures/io/store.ts";

export const leaky = (): string => write();
