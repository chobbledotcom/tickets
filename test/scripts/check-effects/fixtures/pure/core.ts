/** A pure module: its imports reach no effect root. */
import { helper } from "./helper.ts";

export const core = (): string => helper();
