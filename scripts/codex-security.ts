#!/usr/bin/env -S deno run -A

import { runCodexSecurity } from "#scripts/codex-security-lib.ts";

await runCodexSecurity(Deno.args);
