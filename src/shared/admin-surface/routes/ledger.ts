import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getLedger", "ledger", "GET", "/admin/ledger"),
  route("getLedgerByTypeByRef", "ledger", "GET", "/admin/ledger/:type/:ref"),
  route(
    "getLedgerByTypeByRefAdd",
    "ledger",
    "GET",
    "/admin/ledger/:type/:ref/add",
  ),
  route(
    "getLedgerEntriesByIdEdit",
    "ledger",
    "GET",
    "/admin/ledger/entries/:id/edit",
  ),
  route(
    "postLedgerByTypeByRefAdd",
    "ledger",
    "POST",
    "/admin/ledger/:type/:ref/add",
  ),
  route(
    "postLedgerEntriesByIdDelete",
    "ledger",
    "POST",
    "/admin/ledger/entries/:id/delete",
  ),
  route(
    "postLedgerEntriesByIdEdit",
    "ledger",
    "POST",
    "/admin/ledger/entries/:id/edit",
  ),
] as const;
