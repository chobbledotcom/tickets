import { After, Before } from "@cucumber/cucumber";
import { setupTestDbEnvironment } from "#test-utils/db.ts";
import { clearTestEncryptionKey } from "#test-utils/env.ts";
import { reclaimLeakedFdsNow } from "#test-utils/reclaim-fds.ts";
import {
  addDatabaseCleanup,
  cleanupWorld,
  type TicketsWorld,
} from "./world.ts";

Before(async function (this: TicketsWorld): Promise<void> {
  this.cleanup = [];
  this.listingIds = new Map();
  const cleanupDb = await setupTestDbEnvironment(true).catch((error) => {
    clearTestEncryptionKey();
    throw error;
  });
  addDatabaseCleanup(this, cleanupDb, clearTestEncryptionKey);
});

After(async function (this: TicketsWorld): Promise<void> {
  try {
    await cleanupWorld(this);
  } finally {
    reclaimLeakedFdsNow();
  }
});
