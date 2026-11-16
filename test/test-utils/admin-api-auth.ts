import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { mockRequest } from "#test-utils/mocks.ts";

/** Assert the admin API refuses a request to `path` without credentials: the
 *  route answers its 401 before any handler runs. */
export const expectUnauthorized = async (path: string): Promise<void> => {
  const response = await handleRequest(mockRequest(path));
  expect(response.status).toBe(401);
};
