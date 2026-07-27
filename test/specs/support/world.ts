import type { World } from "@cucumber/cucumber";
import { type CleanupTask, runCleanups } from "#scripts/cleanup.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

export interface TicketsWorld extends World {
  attendeeId?: number;
  attendeeIds?: number[];
  attendeeName?: string;
  cleanup: Array<() => void | Promise<void>>;
  firstBody?: string;
  firstFailureData?: string;
  firstStatus?: number;
  holdListingId?: number;
  listingId?: number;
  listingIds: Map<string, number>;
  paymentBrowser?: TestBrowser;
  paymentCaseId?: number;
  paymentCaseRevision?: number;
  paymentManagerHome?: string;
  paymentManagerListStatus?: number;
  paymentProviderCalls?: () => number;
  placeholderId?: number;
  refundCalls?: () => number;
  secondBody?: string;
  secondStatus?: number;
  servicingEventId?: number;
  sessionId?: string;
  ticketToken?: string;
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
