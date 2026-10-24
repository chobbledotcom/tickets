import { expect } from "@std/expect";

export const expectJsonResponse =
  <T = any>(status: number, assertions?: (body: T) => void) =>
  async (response: Response): Promise<T> => {
    expect(response.status).toBe(status);
    const body = (await response.json()) as T;
    assertions?.(body);
    return body;
  };

export const assertJson = async <T = any>(
  request: Promise<Response>,
  status: number,
  assertions?: (body: T) => void,
): Promise<T> => {
  const response = await request;
  return expectJsonResponse<T>(status, assertions)(response);
};

/** PUT `{ name: "" }` to a JSON API entity endpoint and assert the standard
 *  400 "name cannot be empty" rejection. The PUT-name-empty validation is
 *  shared by every writable-named admin entity (holidays, groups, listings),
 *  so hoisting the assertion here keeps each api test focused on the
 *  behaviour specific to that resource. */
export const expectRejectsEmptyName = async (path: string): Promise<void> => {
  const { apiRequest } = await import("#test-utils/session.ts");
  await assertJson(
    apiRequest(path, { body: { name: "" }, method: "PUT" }),
    400,
    (body) => {
      expect(body.error).toBe("name cannot be empty");
    },
  );
};

/** DELETE a named resource via the admin JSON API with a confirmation and
 *  assert the standard `{ status: "ok" }` 200 response. */
export const assertApiDeleteOk = async (
  url: string,
  confirmationName: string,
): Promise<void> => {
  const { apiRequest } = await import("#test-utils/session.ts");
  await assertJson(
    apiRequest(url, {
      body: { confirm_identifier: confirmationName },
      method: "DELETE",
    }),
    200,
    (body) => {
      expect(body.status).toBe("ok");
    },
  );
};
