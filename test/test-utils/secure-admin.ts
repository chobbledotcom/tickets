import { handleRequest } from "#routes";
import { mockRequestWithHost } from "#test-utils/mocks.ts";
import { testCookie } from "#test-utils/session.ts";

export const secureAdminCookie = async (): Promise<string> => {
  const cookie = await testCookie();
  const token = cookie.split("=").slice(1).join("=");
  return `__Host-session=${token}`;
};

export const secureAdminGet = (
  path: string,
  host: string,
  cookie: string,
): Promise<Response> =>
  handleRequest(mockRequestWithHost(path, host, { headers: { cookie } }));
