import { After, AfterAll, Before } from "@cucumber/cucumber";
import { setupTestDbEnvironment } from "#test-utils/db.ts";
import { clearTestEncryptionKey } from "#test-utils/env.ts";
import { reclaimLeakedFdsNow } from "#test-utils/reclaim-fds.ts";
import { cleanupWorld, type TicketsWorld } from "./world.ts";

Before(async function (this: TicketsWorld): Promise<void> {
  this.cleanup = [];
  const cleanupDb = await setupTestDbEnvironment(true);
  this.cleanup.push(() => {
    cleanupDb();
    clearTestEncryptionKey();
  });
});

After(async function (this: TicketsWorld): Promise<void> {
  await cleanupWorld(this);
});

AfterAll((): void => {
  reclaimLeakedFdsNow();
});
