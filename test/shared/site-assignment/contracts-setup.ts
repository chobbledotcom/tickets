import { stub } from "@std/testing/mock";
import { insertBuiltSite } from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { assignAndNotifyBuiltSites } from "#shared/site-assignment.ts";
import { makeTestEntry } from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

export const assignmentEntry = (attendeeId = 81) =>
  makeTestEntry(
    {
      assign_built_site: true,
      id: 71,
      initial_site_months: 3,
      name: "Hosted listing",
    },
    { id: attendeeId },
  );

export const sendSetupEmail = async (siteNames: readonly string[]) => {
  using fetchStub = stubFetch(new Response());
  using _secret = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
    Promise.resolve({ ok: true as const }),
  );
  for (const [index, name] of siteNames.entries()) {
    await insertBuiltSite(
      `Site ${name}`,
      `${name.toLowerCase()}.test`,
      "",
      "",
      true,
      String(101 + index),
    );
  }

  await assignAndNotifyBuiltSites(
    siteNames.map((_, index) => assignmentEntry(81 + index)),
  );

  return JSON.parse(fetchStub.calls[0]!.args[1].body);
};
