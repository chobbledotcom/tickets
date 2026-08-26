/**
 * Report exported fields that nothing reads.
 *
 * Run `deno task unread-fields`. This reports; it does not gate. See
 * `scripts/unread-fields/README.md` for what it can and cannot see.
 */

import { reportLines } from "./unread-fields/findings.ts";
import { scanUnreadFields } from "./unread-fields/scan.ts";

const findings = await scanUnreadFields(Deno.cwd());
for (const line of reportLines(findings)) console.log(line);
