/**
 * One content write plus its activity line, committed atomically, then
 * redirected with the write's flash message.
 */

import { logActivity } from "#db/activity-log.ts";
import { type TxScope, withTransaction } from "#db/client.ts";
import type { CrudHandlers } from "#routes/admin/route-tables.ts";
import { recordRoutes } from "#routes/admin/route-tables.ts";
import { SITE_FORM, SITE_MULTIPART } from "#routes/auth.ts";
import { redirect } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminDestination, adminPattern } from "#shared/admin-surface.ts";
import type { RecordSurface } from "#shared/rest/record.ts";
import {
  createItemImageHandlers,
  type ImagePanelRecord,
} from "./item-images.ts";

type SavedContent = {
  flashMessage: string;
  logMessage: string;
  path: string;
};

/** Write content and its activity row in one transaction. The callback can
 * reject before writing by returning a validation response. No activity is
 * then logged. */
export const saveContent = async <T>(
  write: (transaction: TxScope) => Promise<T | Response>,
  complete: (value: T) => SavedContent,
): Promise<Response> => {
  const saved = await withTransaction(async (transaction) => {
    const value = await write(transaction);
    if (value instanceof Response) return value;
    const completion = complete(value);
    await logActivity(completion.logMessage, undefined, undefined, transaction);
    return completion;
  });
  return saved instanceof Response
    ? saved
    : redirect(saved.path, saved.flashMessage, true);
};

/** The save and refusal paths a Site content record shares. Its saves return
 *  to the record's Edit tab. Its refusals return to the new page or that
 *  tab. */
export const contentPagePaths = (record: RecordSurface) => {
  const path = adminDestination(record.list).pattern;
  return {
    createErrorPath: `${path}/new`,
    editErrorPath: (id: number) => `${path}/${id}/edit`,
    savePath: (id: number) => `${path}/${id}/edit`,
  };
};

/** The image panel handlers a Site content record shares: the site gates, the
 *  Edit tab as the disabled-storage target, and the record's image path. */
export const contentImageHandlers = <T>(
  config: {
    record: RecordSurface;
  } & ImagePanelRecord<T>,
) => {
  const path = adminDestination(config.record.list).pattern;
  return createItemImageHandlers({
    auth: { form: SITE_FORM, multipart: SITE_MULTIPART },
    disabledPath: (id) => `${path}/${id}/edit`,
    itemType: config.itemType,
    load: config.load,
    nameOf: config.nameOf,
    path: (id) => `${path}/${id}/images`,
  });
};

/** The ten standard route entries a Site content record binds. They are the
 *  list, the record page and tabs, the delete page, the new page, and the
 *  four writes. */
export const contentRecordRoutes = <
  List extends AdminDestinationId,
  Detail extends AdminDestinationId,
>(
  list: List,
  detail: Detail,
  handlers: CrudHandlers,
  images: { set: RouteHandlerFn; upload: RouteHandlerFn },
  entityPage: {
    renderTab: (request: Request, id: number, tab: string) => Promise<Response>;
  },
) => ({
  ...recordRoutes(
    adminPattern(list),
    adminPattern(detail),
    handlers,
    entityPage,
  ),
  [`POST ${adminPattern(list)}/:id/images`]: images.set,
  [`POST ${adminPattern(list)}/:id/images/upload`]: images.upload,
});
