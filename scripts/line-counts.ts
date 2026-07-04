#!/usr/bin/env -S deno run --allow-read=src,test

import { printLineCounts } from "./line-counts-lib.ts";

await printLineCounts(["src", "test"], console.log);
