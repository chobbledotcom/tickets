import {
  handleLedgerEntryAddGet,
  handleLedgerEntryAddPost,
  handleLedgerEntryDeletePost,
  handleLedgerEntryEditGet,
  handleLedgerEntryEditPost,
} from "#routes/admin/ledger/entries.ts";
import { handleLedgerGet } from "#routes/admin/ledger/page.ts";
import { handleAccountStatementGet } from "#routes/admin/ledger/statements.ts";
import { defineAdminRoutes } from "#routes/admin/route-tables.ts";

export const adminHandlers = defineAdminRoutes({
  "GET /admin/ledger": handleLedgerGet,
  "GET /admin/ledger/:type/:ref": handleAccountStatementGet,
  "GET /admin/ledger/:type/:ref/add": handleLedgerEntryAddGet,
  "GET /admin/ledger/entries/:id/edit": handleLedgerEntryEditGet,
  "POST /admin/ledger/:type/:ref/add": handleLedgerEntryAddPost,
  "POST /admin/ledger/entries/:id/delete": handleLedgerEntryDeletePost,
  "POST /admin/ledger/entries/:id/edit": handleLedgerEntryEditPost,
});
