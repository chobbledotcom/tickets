import * as v from "valibot";
import type { Table } from "#cli/commands.ts";
import type { RunDeps } from "#cli/run.ts";
import type { AdminApiRequest } from "#shared/admin-api-client.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiResource,
} from "#shared/admin-api-resources.ts";

/** A resource the production table does not carry, so CLI tests can prove
 *  describe and the parser read the table they are handed. */
export const gadgetEntry: AdminApiResource = {
  children: {
    parts: {
      bodySchema: v.object({ label: v.string() }),
      idParam: "partId",
      path: "parts",
      responseSchema: v.looseObject({ gadget: v.unknown() }),
    },
  },
  createBodySchema: v.object({
    name: v.string(),
    size: v.optional(v.number()),
  }),
  custom: {
    recalibrate: { method: "POST", subpath: ":gadgetId/recalibrate" },
  },
  label: "Gadget",
  listSchema: v.looseObject({ gadgets: v.array(v.unknown()) }),
  path: "gadgets",
  singleSchema: v.looseObject({ gadget: v.unknown() }),
};

export const testTable: Table = {
  ...ADMIN_API_RESOURCES,
  gadgets: gadgetEntry,
};

export const testConfig = {
  apiHostname: "https://tickets.example.com",
  apiKey: "key",
};

/** One transport that answers every call with one canned body and records
 *  the requests it received. */
export const recordingTransport = (
  answer: unknown,
  status = 200,
): { requests: AdminApiRequest[]; transport: RunDeps["transport"] } => {
  const requests: AdminApiRequest[] = [];
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      return { data: answer, status };
    },
  };
};

/** The runner deps one CLI test needs, with per-test overrides. */
export const runDeps = (
  table: Table,
  transport: RunDeps["transport"],
  overrides: Partial<RunDeps> = {},
): RunDeps => ({
  config: async () => testConfig,
  readStdin: async () => "{}",
  table,
  transport,
  ...overrides,
});
