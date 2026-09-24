/** A content-editing GET on one record: the audience the listing and group
 * create-edit pages use, the load, and the 404 dance in one shared gate. */

import { type AuthSession, requireContentOr } from "#routes/auth.ts";
import { notFoundResponse } from "#routes/response.ts";

/** A record load behind the content gate. */
export type ContentRecordLoad<T> = (
  id: number,
  session: AuthSession,
) => Promise<T | null>;

/** Gate a content-editing GET on a record: refuse outside the content
 * audience, 404 a null load, then hand the loaded record and session to
 * `then`. */
export const contentRecordPage = <T>(
  request: Request,
  id: number,
  load: ContentRecordLoad<T>,
  then: (record: T, session: AuthSession) => Promise<Response>,
): Promise<Response> =>
  requireContentOr(request, async (session) => {
    const record = await load(id, session);
    if (!record) return notFoundResponse();
    return then(record, session);
  });
