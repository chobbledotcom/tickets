import { checkVerification } from "#scripts/check-tla/run.ts";
import { runDenoScript } from "#scripts/script-runner.ts";

await runDenoScript(async (io) => {
  if (io.args.length > 0) {
    io.stderr("Usage: deno task check:tla");
    return 2;
  }
  return await checkVerification({ log: io.stdout, logError: io.stderr });
});
