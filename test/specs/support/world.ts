import type { World } from "@cucumber/cucumber";
import { type CleanupTask, runCleanups } from "#scripts/cleanup.ts";

export interface TicketsWorld extends World {
  cleanup: Array<() => void | Promise<void>>;
  firstBody?: string;
  firstFailureData?: string;
  firstStatus?: number;
  listingId?: number;
  placeholderId?: number;
  refundCalls?: () => number;
  secondBody?: string;
  secondStatus?: number;
  sessionId?: string;
}

export const cleanupWorld = (
  world: Pick<TicketsWorld, "cleanup">,
): Promise<void> => runCleanups(world.cleanup.reverse());

export const addDatabaseCleanup = (
  world: Pick<TicketsWorld, "cleanup">,
  cleanupDb: CleanupTask,
  clearEncryptionKey: CleanupTask,
): void => {
  world.cleanup.push(clearEncryptionKey, cleanupDb);
};

export const requiredWorldValue = <Value>(
  value: Value | undefined,
  name: string,
): Value => {
  if (value === undefined) throw new Error(`${name} was not set`);
  return value;
};
