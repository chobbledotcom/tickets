import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute, queryAll } from "#db/client.ts";
import { logisticsAgents } from "#db/logistics-agents.ts";
import { agentUsers, userAgents } from "#db/user-agents.ts";
import { logisticsAgentRecord } from "#shared/records/logistics-agents.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createAttendeeOn } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { deleteConfirmLabel } from "#test-utils/record-labels.ts";

type AgentColumns = {
  end_agent_id: number | null;
  start_agent_id: number | null;
};

describe("the logistics agent record's declaration", () => {
  test("names an agent on its pages and its delete page", () => {
    expect(logisticsAgentRecord.activityName).toBe("Logistics agent");
    expect(deleteConfirmLabel(logisticsAgentRecord)).toBe(
      "Logistics agent name",
    );
  });
});

describeWithEnv("the logistics agent record's commands", { db: true }, () => {
  test("creates an agent and logs it with the agent name", async () => {
    expect(await logisticsAgentRecord.create({ name: "Van 1" })).toEqual({
      kind: "written",
      row: { id: 1, name: "Van 1" },
    });
    expect(await activityMessages()).toEqual([
      "Logistics agent 'Van 1' created",
    ]);
  });

  test("deletes an agent and clears every booking and user link to it", async () => {
    const agent = await logisticsAgents.table.insert({ name: "Van 2" });
    const listing = await createTestListing({ name: "Delivery" });
    await createAttendeeOn(listing, "Ann", "ann@example.com");
    await execute(
      "UPDATE listing_attendees SET start_agent_id = ?, end_agent_id = ?",
      [agent.id, agent.id],
    );
    await userAgents.setIds(1, [agent.id]);

    expect(await logisticsAgentRecord.remove(agent.id)).toEqual({
      kind: "deleted",
    });
    expect([
      await logisticsAgents.table.read.one({ id: agent.id }),
      await agentUsers.getIds(agent.id),
      await queryAll<AgentColumns>(
        "SELECT start_agent_id, end_agent_id FROM listing_attendees",
      ),
    ]).toEqual([null, [], [{ end_agent_id: null, start_agent_id: null }]]);
    expect((await activityMessages())[0]).toBe(
      "Logistics agent 'Van 2' deleted",
    );
  });
});
