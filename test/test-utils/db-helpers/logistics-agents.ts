import { logisticsAgents } from "#db/logistics-agents.ts";
import { adminFormPost } from "#test-utils/session.ts";

export const createLogisticsAgent = async (name: string): Promise<number> => {
  await adminFormPost("/admin/logistics", { name });
  const agents = await logisticsAgents.getAll();
  return agents.find((a) => a.name === name)!.id;
};
