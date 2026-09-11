// test-groups: run-alone
import { expect } from "@std/expect";

Deno.test({
  async fn() {
    const { PrecommitStatusSchema } = await import(
      "#scripts/precommit/status-schema.ts"
    );
    const { safeParse } = await import("valibot");
    expect(safeParse(PrecommitStatusSchema, {}).success).toBe(false);
  },
  name: "precommit status schema imports without runtime IO permissions",
  permissions: "none",
});
