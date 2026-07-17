import { writeTestState } from "../../test/test-utils/test-state.ts";

const dir = Deno.args[0];
if (!dir) throw new Error("A test-state output directory is required.");
await writeTestState(dir);
