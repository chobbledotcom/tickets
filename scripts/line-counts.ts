// Run via `deno task line-counts`, which grants --allow-read=src,test.

import { printLineCounts } from "./line-counts-lib.ts";

await printLineCounts(["src", "test"], console.log);
