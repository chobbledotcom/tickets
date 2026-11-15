import { getAllUsers } from "#db/users.ts";
import { createLogisticsAgent } from "#test-utils/db-helpers/logistics-agents.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Create a logistics agent and assign the first stored user to it through the
 *  edit form. Answers the agent's id, that user's id, and the POST's response,
 *  so a caller can check the flash or read the form back. */
export const createAgentAssignedToFirstUser = async (
  name: string,
): Promise<{ id: number; response: Response; userId: number }> => {
  const id = await createLogisticsAgent(name);
  const userId = (await getAllUsers())[0]!.id;
  const { response } = await adminFormPost(`/admin/logistics/${id}/edit`, {
    name,
    user_ids: String(userId),
  });
  return { id, response, userId };
};
