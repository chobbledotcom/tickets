/** The invoice lifecycle machine: one attendee and two invoice numbers.
 *  Every fact comes from a production statement, run on an isolated in-memory
 *  copy of the production schema. See verification/InvoiceFlow.tla. */

import type { Client } from "@libsql/client";
import * as v from "valibot";

import {
  CANCEL_INVOICE_SQL,
  markOpenInvoicesPaidStatement,
} from "#db/invoices.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import {
  corruptOneFact,
  type ModelDataSource,
  type TlaFact,
  tlaModule,
  tlaRecords,
  tlaSet,
} from "#scripts/verify-models/data.ts";
import { schemaClientWith } from "#scripts/verify-models/schema-client.ts";
import {
  INVOICE_STATUSES,
  type InvoiceStatus,
  InvoiceStatusSchema,
} from "#shared/invoices/status.ts";

/** The attendee every scenario invoices. The model claims about one attendee. */
const ATTENDEE_ID = 7;

/** The stored creation time, which the model never reads. */
const CREATED = "2026-11-03T09:00:00.000Z";

/** The status of a free invoice number: the table stores no row for it. */
const ABSENT = "absent";

/** One invoice number's stored status, or absent when no row holds it. */
type SlotStatus = InvoiceStatus | typeof ABSENT;

/** One action the application offers on an invoice. */
type AttemptKind = "cancel" | "create" | "settle";

/** The two invoice numbers the model watches, as example identities. */
const SLOTS = [1, 2] as const;

/** One scenario: the stored status at each invoice number before the action. */
type Scenario = readonly [SlotStatus, SlotStatus];

/** One attempted action: which number it acts on, and the guard input. */
type AttemptInput = {
  /** Whether the settle's balance comparison held on this attempt. */
  guardMatched: boolean;
  kind: AttemptKind;
  slot: 1 | 2;
  statuses: Scenario;
};

/** The create form's insert is injectable so the tests can reach the
 *  unexpected-failure path. */
export type InvoiceFlowDeps = {
  run: (client: Client, statement: SqlStatement) => Promise<unknown>;
};

const DEFAULT_DEPS: InvoiceFlowDeps = {
  run: (client, statement) => client.execute(statement),
};

/** Whether an insert failure is the one open-invoice refusal. Any other
 *  failure is unexpected and must escape. */
export const isOpenInvoiceRefusal = (error: unknown): boolean =>
  error instanceof Error &&
  /UNIQUE constraint failed: invoices\.attendee_id/.test(error.message);

/** One invoice row with one stored status. The seal holds placeholder
 *  ciphertext: this model reads the status column only. */
const invoiceRow = (
  slot: number,
  status: InvoiceStatus,
): SqlStatement => sql`INSERT INTO invoices
          (id, attendee_id, body, status, share_token, share_token_index, created)
        VALUES (${slot}, ${ATTENDEE_ID}, ${"enc:1:AQ==:AQ=="}, ${status}, ${"hyb:1:AQ==:AQ==:AQ=="}, ${`share-index-${slot}`}, ${CREATED})`;

/** A fresh copy of the scenario: the production schema, then the rows the
 *  scenario names. */
const seededClient = async (statuses: Scenario): Promise<Client> => {
  const rows: SqlStatement[] = [];
  for (const slot of SLOTS) {
    const status = storedStatus(statusMap(statuses), slot);
    if (status !== ABSENT) rows.push(invoiceRow(slot, status));
  }
  return schemaClientWith(rows);
};

/** The statuses the table stores now, keyed by invoice number. An absent key
 *  means the number has no row. */
const storedStatuses = async (
  client: Client,
): Promise<ReadonlyMap<number, SlotStatus>> =>
  new Map(
    (await client.execute(sql`SELECT id, status FROM invoices`)).rows.map(
      (row) =>
        [Number(row.id), v.parse(InvoiceStatusSchema, row.status)] as const,
    ),
  );

/** The status at one number, or absent when no row stores it. */
const storedStatus = (
  statuses: ReadonlyMap<number, SlotStatus>,
  slot: number,
): SlotStatus => statuses.get(slot) ?? ABSENT;

/** The other invoice number. */
const otherSlot = (slot: 1 | 2): 1 | 2 => (slot === 1 ? 2 : 1);

/** The status one accepted action reaches, keyed by action. */
const TARGET: Record<AttemptKind, InvoiceStatus> = {
  cancel: "cancelled",
  create: "new",
  settle: "paid",
};

/** The guard input each action's statement compares. */
type GuardInput = {
  guardMatched: boolean;
  otherNew: boolean;
  statusBefore: SlotStatus;
};

/** The acceptance rule each production statement applies. A create's rule is
 *  the unique index on the attendee's open invoice. */
const ACCEPTANCE: Record<AttemptKind, (input: GuardInput) => boolean> = {
  cancel: ({ statusBefore }) => statusBefore === "new",
  create: ({ otherNew }) => !otherNew,
  settle: ({ guardMatched, statusBefore }) =>
    statusBefore === "new" && guardMatched,
};

/** The stored statuses before one attempt, keyed by number. */
const statusMap = (statuses: Scenario): ReadonlyMap<number, SlotStatus> =>
  new Map([
    [1, statuses[0]],
    [2, statuses[1]],
  ]);

/** One fact: the action's guard input, the stored result, and its verdicts. */
const factFor = ({
  accepted,
  after,
  before,
  guardMatched,
  kind,
  slot,
}: {
  accepted: boolean;
  after: ReadonlyMap<number, SlotStatus>;
  before: ReadonlyMap<number, SlotStatus>;
  guardMatched: boolean;
  kind: AttemptKind;
  slot: 1 | 2;
}): InvoiceAttempt => {
  const statusBefore = storedStatus(before, slot);
  const otherNew = storedStatus(before, otherSlot(slot)) === "new";
  const checks = {
    acceptedCorrect:
      accepted === ACCEPTANCE[kind]({ guardMatched, otherNew, statusBefore }),
    otherKept:
      storedStatus(after, otherSlot(slot)) ===
      storedStatus(before, otherSlot(slot)),
    statusAfterCorrect:
      storedStatus(after, slot) === (accepted ? TARGET[kind] : statusBefore),
  };
  return {
    ...checks,
    accepted,
    guardMatched,
    kind,
    otherNew,
    safe: Object.values(checks).every(Boolean),
    slot,
    statusAfter: storedStatus(after, slot),
    statusBefore,
  };
};

/** Run one create's insert and report whether the row landed. */
const createAccepted = async (
  client: Client,
  slot: 1 | 2,
  deps: InvoiceFlowDeps,
): Promise<boolean> => {
  try {
    await deps.run(client, invoiceRow(slot, "new"));
    return true;
  } catch (error) {
    if (!isOpenInvoiceRefusal(error)) throw error;
    return false;
  }
};

/** Run the statement one cancel or settle uses, and report whether it changed
 *  a row. */
const updateAccepted = async (
  client: Client,
  { guardMatched, kind, slot }: AttemptInput,
): Promise<boolean> =>
  (
    await client.execute(
      kind === "cancel"
        ? { args: [slot], sql: CANCEL_INVOICE_SQL }
        : markOpenInvoicesPaidStatement(ATTENDEE_ID, "1", guardMatched ? 1 : 0),
    )
  ).rowsAffected > 0;

/** One attempt on a fresh copy of its scenario. */
const attemptFact = async (
  input: AttemptInput,
  deps: InvoiceFlowDeps,
): Promise<InvoiceAttempt> => {
  const client = await seededClient(input.statuses);
  try {
    const accepted =
      input.kind === "create"
        ? await createAccepted(client, input.slot, deps)
        : await updateAccepted(client, input);
    return factFor({
      accepted,
      after: await storedStatuses(client),
      before: statusMap(input.statuses),
      guardMatched: input.guardMatched,
      kind: input.kind,
      slot: input.slot,
    });
  } finally {
    client.close();
  }
};

/** One scenario's facts, run against one invoice number. */
type SlotScope = {
  deps: InvoiceFlowDeps;
  slot: 1 | 2;
  statuses: Scenario;
};

/** One attempt input for this scope. */
const inputFor = (
  { slot, statuses }: SlotScope,
  kind: AttemptKind,
  guardMatched = false,
): AttemptInput => ({ guardMatched, kind, slot, statuses });

/** The two settle attempts for one number: the balance guard matched, then
 *  unmatched. */
const settleFacts = (scope: SlotScope): Promise<readonly InvoiceAttempt[]> =>
  Promise.all(
    [false, true].map((guardMatched) =>
      attemptFact(inputFor(scope, "settle", guardMatched), scope.deps),
    ),
  );

/** Every fact for one invoice number in one scenario. A free number gets one
 *  create. A stored number gets one cancel. An open number, or a scenario with
 *  no open invoice, also gets both settle attempts. A settle never runs beside
 *  a second open invoice, so one row changes and the other stays. */
const slotFacts = async (
  scope: SlotScope,
): Promise<readonly InvoiceAttempt[]> => {
  const status = storedStatus(statusMap(scope.statuses), scope.slot);
  const facts: InvoiceAttempt[] = [
    await attemptFact(
      inputFor(scope, status === ABSENT ? "create" : "cancel"),
      scope.deps,
    ),
  ];
  if (
    status !== ABSENT &&
    (status === "new" || !scope.statuses.includes("new"))
  )
    facts.push(...(await settleFacts(scope)));
  return facts;
};

/** The scenarios: the open invoice on either number, each closed status, and a
 *  closed invoice beside the open one. */
const SCENARIOS: readonly Scenario[] = [
  ["new", ABSENT],
  [ABSENT, "new"],
  ["cancelled", ABSENT],
  [ABSENT, "cancelled"],
  ["paid", ABSENT],
  ["new", "cancelled"],
];

/** Every fact the checker reads: each scenario's cancels and settles, and
 *  creates on each free number. */
export const invoiceFlowFacts = async (
  deps: InvoiceFlowDeps = DEFAULT_DEPS,
): Promise<readonly InvoiceAttempt[]> => {
  const attempts: InvoiceAttempt[] = [];
  for (const statuses of SCENARIOS)
    for (const slot of SLOTS)
      attempts.push(...(await slotFacts({ deps, slot, statuses })));
  return attempts;
};

const fields = {
  accepted: "Bool",
  acceptedCorrect: "Bool",
  guardMatched: "Bool",
  kind: "Str",
  otherKept: "Bool",
  otherNew: "Bool",
  safe: "Bool",
  slot: "Int",
  statusAfter: "Str",
  statusAfterCorrect: "Bool",
  statusBefore: "Str",
} as const;

export type InvoiceAttempt = TlaFact<typeof fields>;

const moduleFor = (attempts: readonly InvoiceAttempt[]): string =>
  tlaModule("InvoiceFlowData", [
    `InvoiceStatuses == ${tlaSet([ABSENT, ...INVOICE_STATUSES])}`,
    tlaRecords("Attempts", fields, attempts),
  ]);

/** The clean proof data. The check must pass. */
export const invoiceFlowModelData: ModelDataSource = async () =>
  moduleFor(await invoiceFlowFacts());

const corruptDataFor =
  (
    corrupt: (attempts: readonly InvoiceAttempt[]) => readonly InvoiceAttempt[],
  ): ModelDataSource =>
  async () =>
    moduleFor(corrupt(await invoiceFlowFacts()));

/** A corrupted fact claims its action succeeded and reopened the invoice. */
const reopensAsNew = (attempt: InvoiceAttempt): InvoiceAttempt => ({
  ...attempt,
  accepted: true,
  acceptedCorrect: false,
  safe: false,
  statusAfter: "new",
  statusAfterCorrect: false,
});

/** One negative control's data: every fact the predicate names is corrupted. */
const controlData = (
  isVictim: (attempt: InvoiceAttempt) => boolean,
  missingMessage: string,
): ModelDataSource =>
  corruptDataFor((attempts) =>
    corruptOneFact(attempts, isVictim, missingMessage, reopensAsNew),
  );

/** The negative control for a second open invoice: the index lets the create
 *  land beside the open one. The checker must reject it. */
export const secondOpenInvoiceData = controlData(
  (attempt) =>
    attempt.kind === "create" && !attempt.accepted && attempt.otherNew,
  "No create attempt meets an open invoice.",
);

/** The negative control for a reopened invoice: a cancel turns a closed
 *  invoice back into a new one. The checker must reject it. */
export const reopenedInvoiceData = controlData(
  (attempt) =>
    attempt.kind === "cancel" && attempt.statusBefore === "cancelled",
  "No cancel attempt acts on a cancelled invoice.",
);
