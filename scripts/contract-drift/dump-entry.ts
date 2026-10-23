/** The worktree side of `deno task contract:diff`: print this checkout's
 * declared contracts as JSON. The base worktree receives only this
 * folder, so this file must stay a thin shell over `dump.ts`. */

import { currentContracts } from "./dump.ts";

console.log(JSON.stringify(await currentContracts()));
