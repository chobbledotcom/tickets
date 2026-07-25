import type { World } from "@cucumber/cucumber";

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

export const requiredWorldValue = <Value>(
  value: Value | undefined,
  name: string,
): Value => {
  if (value === undefined) throw new Error(`${name} was not set`);
  return value;
};
