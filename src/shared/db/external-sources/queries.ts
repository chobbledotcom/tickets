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
  queryAll,
  resultRows,
  type TxScope,
  withTransaction,
} from "#db/client.ts";
import { sql, sqlList, sqlNames, type SqlStatement } from "#db/sql.ts";
import type { RowFilter } from "#db/table-reader.ts";
import { requireValue } from "#shared/required-value.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { externalSourceLinksTable, externalSourcesTable } from "./tables.ts";
import { type ExternalLinkTarget, externalLinkTargets } from "./target.ts";
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
  externalSourcesTable.read.many({}, { order: sql`id ASC` });

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

/** One source's links, oldest first. */
export const listExternalSourceLinks = async (
  sourceId: number,
  filter: ExternalLinkFilter,
): Promise<ExternalSourceLink[]> =>
  externalSourceLinksTable.read.many(await linkFilter(sourceId, filter), {
    order: sql`id ASC`,
  });

/** Every source's links that name one record, oldest first. The record page
 *  reads this once instead of asking each source in turn. */
export const listExternalLinksForTarget = (
  target: ExternalLinkTarget,
): Promise<ExternalSourceLink[]> =>
  externalSourceLinksTable.read.many(
    { link_id: target.id, link_type: target.kind },
    { order: sql`id ASC` },
  );

/** One link found by its external id, with the source that holds it. */
export type ExternalLinkMatch = {
  link: ExternalSourceLink;
  source: ExternalSource;
};

const LINK_COLUMNS = sqlNames(externalSourceLinksTable.columns);

/** The sources under their ids, for pairing a row with the source that holds
 *  it. */
export const sourcesById = (
  sources: readonly ExternalSource[],
): ReadonlyMap<number, ExternalSource> =>
  new Map(sources.map((source) => [source.id, source]));

/** One record's links found by its external id, in every source that holds it.
 *  The blind index binds the id to its source, so the query hashes the id once
 *  per source and matches them all in one statement. */
export const lookupExternalLinks = async (
  externalId: string,
): Promise<ExternalLinkMatch[]> => {
  const sources = await getAllExternalSources();
  if (sources.length === 0) return [];
  const indexes = await Promise.all(
    sources.map((source) => externalLinkIndex(source.id, externalId)),
  );
  const stored = await queryAll<ExternalSourceLink>(
    sql`SELECT ${LINK_COLUMNS} FROM external_source_links
      WHERE external_id_index IN (${sqlList(indexes)})
      ORDER BY id ASC`,
  );
  const byId = sourcesById(sources);
  return Promise.all(
    stored.map(async (row) => ({
      link: await externalSourceLinksTable.fromDb(row),
      source: requireValue(
        byId.get(row.source_id),
        `External source ${row.source_id} is missing`,
      ),
    })),
  );
};

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

/** The two stored facts that refuse a link write, read in one round trip. A
 *  write with no external id skips the duplicate check: the index is empty. */
type LinkWriteFacts = { duplicate: number; target_missing: number };

/** A create passes 0 for the row it does not replace. No stored id is 0. */
const linkWriteFactsStatement = (
  input: ExternalLinkInput,
  excludingId: number,
): SqlStatement => {
  const duplicate =
    input.externalIdIndex === null
      ? sql`0`
      : sql`EXISTS (
        SELECT 1 FROM external_source_links AS existingLink
         WHERE existingLink.source_id = ${input.sourceId}
           AND existingLink.external_id_index = ${input.externalIdIndex}
           AND existingLink.link_type = ${input.linkType}
           AND existingLink.link_id = ${input.linkId}
           AND existingLink.id != ${excludingId}
      )`;
  return sql`SELECT
      ${duplicate} AS duplicate,
      NOT ${externalLinkTargets.existsSql(input.linkType, input.linkId)} AS target_missing`;
};

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
    externalIdIndex:
      write.externalId === null
        ? null
        : await externalLinkIndex(sourceId, write.externalId),
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
    return errorResult(
      "This source already links that record to that external id",
    );
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
      ["created", "id"],
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
