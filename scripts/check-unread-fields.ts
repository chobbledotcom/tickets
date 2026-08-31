import { consoleOutput } from "#scripts/check-report.ts";
import { UNREAD_FIELD_BASELINE } from "#scripts/unread-fields/baseline.ts";
import { UNREAD_FIELD_EXEMPTIONS } from "#scripts/unread-fields/exemptions.ts";
import { runUnreadFieldsCheck } from "#scripts/unread-fields/run-check.ts";
import { scanUnreadFields } from "#scripts/unread-fields/scan.ts";

const code = await runUnreadFieldsCheck(Deno.cwd(), consoleOutput, {
  baseline: UNREAD_FIELD_BASELINE,
  exemptions: UNREAD_FIELD_EXEMPTIONS,
  scan: scanUnreadFields,
});
Deno.exit(code);
