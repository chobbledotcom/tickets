import { checkVerification } from "#scripts/check-tla/run.ts";
import { runCheckCommand } from "#scripts/run-check-command.ts";

await runCheckCommand("check:tla", checkVerification);
