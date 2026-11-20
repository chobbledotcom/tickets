import { checkModelGuides } from "#scripts/model-guides/check.ts";
import { runCheckCommand } from "#scripts/run-check-command.ts";

await runCheckCommand("check:model-guides", checkModelGuides);
