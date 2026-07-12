import { handlersFor } from "#routes/admin/handlers.ts";
import {
  handleLedgerEntryAddGet,
  handleLedgerEntryAddPost,
  handleLedgerEntryDeletePost,
  handleLedgerEntryEditGet,
  handleLedgerEntryEditPost,
} from "#routes/admin/ledger/entries.ts";
import { handleLedgerGet } from "#routes/admin/ledger/page.ts";
import { handleAccountStatementGet } from "#routes/admin/ledger/statements.ts";

export const adminHandlers = handlersFor("ledger")({
  getLedger: handleLedgerGet,
  getLedgerByTypeByRef: handleAccountStatementGet,
  getLedgerByTypeByRefAdd: handleLedgerEntryAddGet,
  getLedgerEntriesByIdEdit: handleLedgerEntryEditGet,
  postLedgerByTypeByRefAdd: handleLedgerEntryAddPost,
  postLedgerEntriesByIdDelete: handleLedgerEntryDeletePost,
  postLedgerEntriesByIdEdit: handleLedgerEntryEditPost,
});
