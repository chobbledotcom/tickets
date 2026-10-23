/** A pure-listed module that reaches the database root through one
 * import hop. */
import { write } from "../io/store.ts";

export const leaky = (): string => write();
