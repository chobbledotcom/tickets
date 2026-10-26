import { getDb } from "#db/client.ts";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { awaitTestRequest, mockMultipartRequest } from "#test-utils/mocks.ts";
import { getTestSession } from "#test-utils/session.ts";

/** GET `path` with the given session cookie. */
export const getAs = (path: string, cookie: string): Promise<Response> =>
  awaitTestRequest(path, { cookie });

/** POST a multipart form to `path` with a signed CSRF token and cookie. */
export const postMultipartAs = async (
  path: string,
  cookie: string,
  data: TestFormValues,
): Promise<Response> => {
  const csrf_token = await signCsrfToken();
  return handleRequest(
    mockMultipartRequest(path, { ...data, csrf_token }, cookie),
  );
};

/** Read a listing's stored booked_quantity directly. */
export const bookedQuantity = async (id: number): Promise<number> => {
  const result = await getDb().execute({
    args: [id],
    sql: "SELECT booked_quantity FROM listings WHERE id = ?",
  });
  return Number((result.rows[0] as Record<string, unknown>).booked_quantity);
};

/** Fetch the owner-only users management page. */
export const adminUsersHtml = async (): Promise<Response> => {
  const { cookie } = await getTestSession();
  return getAs("/admin/users", cookie);
};
