/** Request-scope fakes shared by the Turso API test suites. */

/** A fetch stand-in whose database-create reply is a fixed platform row and
 * whose token reply is the raw `tokenBody`. */
export const createReplyingWith =
  (database: Record<string, string>, tokenBody: string) =>
  (url: string): Response =>
    url.includes("/auth")
      ? new Response(tokenBody)
      : new Response(JSON.stringify({ database }));

/** The env vars the Turso provider tests boot with. */
export const TEST_TURSO_ENV = {
  TURSO_API_TOKEN: "test-turso-token",
  TURSO_GROUP: "default",
  TURSO_ORGANIZATION: "myorg",
};
