/**
 * Reading and writing the external sources directory.
 *
 * Every read opens its rows with the request's owner key, and every write seals
 * them first (see ./sealing.ts). A link also carries a blind index of its
 * external id, so a lookup finds the row without decrypting any.
 */

/* jscpd:ignore-start -- imports */
import { blindIndexFor } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import {
  deleteByFieldBatch,
  resultRows,
  type TxScope,
  withTransaction,
} from "#db/client.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import type { RowFilter } from "#db/table-reader.ts";
import { requireValue } from "#shared/required-value.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { externalSourceLinksTable, externalSourcesTable } from "./tables.ts";
import { externalLinkTargets } from "./target.ts";
import type {
  ExternalLinkFilter,
  ExternalLinkInput,
  ExternalLinkWrite,
  ExternalSource,
  ExternalSourceLink,
} from "./types.ts";

/* jscpd:ignore-end */

/** The blind index that finds one link without decrypting. The source is part
 *  of the hashed input, so two sources can hold the same external id. */
const linkIndexFor = blindIndexFor("external-source-link:");

export const externalLinkIndex = (
  sourceId: number,
  externalId: string,
): Promise<BlindIndex> => linkIndexFor(String(sourceId), externalId);

/** Every source, in the order they were added. */
export const getAllExternalSources = (): Promise<ExternalSource[]> =>
  externalSourcesTable.read.many({}, { order: "id ASC" });

export const getExternalSource = (id: number): Promise<ExternalSource | null> =>
  externalSourcesTable.read.one({ id });

/** Delete one source and its links in one batch, so no link outlives the
 *  source that names its place. */
export const deleteExternalSource = (id: number): Promise<void> =>
  deleteByFieldBatch([
    { field: "source_id", table: "external_source_links", value: id },
    { field: "id", table: "external_sources", value: id },
  ]);

/** The filter one links read keeps, written as the row's own shape. */
const linkFilter = async (
  sourceId: number,
  filter: ExternalLinkFilter,
): Promise<RowFilter<ExternalSourceLink>> => {
  if (filter.kind === "external") {
    return {
      external_id_index: await externalLinkIndex(sourceId, filter.externalId),
      source_id: sourceId,
    };
  }
  if (filter.kind === "target") {
    return {
      link_id: filter.linkId,
      link_type: filter.linkType,
      source_id: sourceId,
    };
  }
  return { source_id: sourceId };
};

/** One source's links, opened for an admin. */
export const listExternalSourceLinks = async (
  sourceId: number,
  filter: ExternalLinkFilter,
): Promise<ExternalSourceLink[]> =>
  externalSourceLinksTable.read.many(await linkFilter(sourceId, filter), {
    order: "id ASC",
  });

export const getExternalSourceLink = (
  sourceId: number,
  linkId: number,
): Promise<ExternalSourceLink | null> =>
  externalSourceLinksTable.read.one({ id: linkId, source_id: sourceId });

/** One link a caller just asked to read or write. Its absence is a broken
 *  read-your-writes path, so the caller fails loudly. */
export const requireExternalSourceLink = async (
  sourceId: number,
  linkId: number,
): Promise<ExternalSourceLink> =>
  requireValue(
    await getExternalSourceLink(sourceId, linkId),
    `External source link ${linkId} is missing from source ${sourceId}`,
  );

/** The two stored facts that refuse a link write, read in one round trip. */
type LinkWriteFacts = { duplicate: number; target_missing: number };

/** A create passes 0 for the row it does not replace. No stored id is 0. */
const linkWriteFactsStatement = (
  input: ExternalLinkInput,
  excludingId: number,
) =>
  numberedStatement((bind) => {
    const target = externalLinkTargets.of(input.linkType)(input.linkId);
    return `SELECT
      EXISTS (
        SELECT 1 FROM external_source_links AS existingLink
         WHERE existingLink.source_id = ${bind(input.sourceId)}
           AND existingLink.external_id_index = ${bind(input.externalIdIndex)}
           AND existingLink.id != ${bind(excludingId)}
      ) AS duplicate,
      NOT ${externalLinkTargets.existsSql(target.kind, bind(target.id))} AS target_missing`;
  });

/** The columns to store for a link write, or the reason it cannot be stored.
 *  The reason names a missing target record, or an external id the source
 *  already holds. The facts read runs inside the write transaction, so a delete
 *  cannot land between the check and the write. */
const prepareLinkWrite = async (
  tx: TxScope,
  sourceId: number,
  write: ExternalLinkWrite,
  excludingId: number,
): Promise<Result<ExternalLinkInput>> => {
  const input: ExternalLinkInput = {
    externalId: write.externalId,
    externalIdIndex: await externalLinkIndex(sourceId, write.externalId),
    linkId: write.linkId,
    linkType: write.linkType,
    sourceId,
  };
  const facts = linkWriteFactsStatement(input, excludingId);
  const stored = requireValue(
    resultRows<LinkWriteFacts>(await tx.execute(facts))[0],
    "The external link write facts query returned no row",
  );
  if (stored.target_missing === 1) {
    return errorResult(`No ${write.linkType} has id ${write.linkId}`);
  }
  if (stored.duplicate === 1) {
    return errorResult("This source already links that external id");
  }
  return okResult(input);
};

/** The row one create stored: the sealed input, plus the keys SQLite made.
 *  A write needs no session, so it must not open the value it just sealed. */
const createdLink = (
  input: ExternalLinkInput,
  row: { created: string; id: number },
): ExternalSourceLink => ({
  created: row.created,
  external_id: input.externalId,
  external_id_index: input.externalIdIndex,
  id: row.id,
  link_id: input.linkId,
  link_type: input.linkType,
  source_id: input.sourceId,
});

/** Run one link write inside the transaction that checks it. The callback
 *  stores the prepared columns and answers with the value to return. */
const withPreparedLinkWrite = <T>(
  sourceId: number,
  write: ExternalLinkWrite,
  excludingId: number,
  store: (tx: TxScope, input: ExternalLinkInput) => Promise<T>,
): Promise<Result<T>> =>
  withTransaction(async (tx) => {
    const prepared = await prepareLinkWrite(tx, sourceId, write, excludingId);
    if (!prepared.ok) return errorResult(prepared.error);
    return okResult(await store(tx, prepared.value));
  });

export const createExternalSourceLink = (
  sourceId: number,
  write: ExternalLinkWrite,
): Promise<Result<ExternalSourceLink>> =>
  withPreparedLinkWrite(sourceId, write, 0, async (tx, input) => {
    const statement = await externalSourceLinksTable.insertStatement(
      input,
      undefined,
      "created, id",
    );
    const row = requireValue(
      resultRows<{ created: string; id: number }>(
        await tx.execute(statement),
      )[0],
      "The external source link insert returned no row",
    );
    return createdLink(input, row);
  });

/** Store a changed link. The caller re-reads the row it answers with. */
export const updateExternalSourceLink = (
  link: ExternalSourceLink,
  write: ExternalLinkWrite,
): Promise<Result<true>> =>
  withPreparedLinkWrite<true>(
    link.source_id,
    write,
    link.id,
    async (tx, input) => {
      await tx.execute(
        await externalSourceLinksTable.updateStatement(link.id, input),
      );
      return true;
    },
  );

export const deleteExternalSourceLink = (
  link: ExternalSourceLink,
): Promise<void> => externalSourceLinksTable.deleteById(link.id);
