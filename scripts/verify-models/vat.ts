import {
  moveFields,
  type TlaFact,
  tlaModule,
  tlaRecords,
  tlaSet,
} from "#scripts/verify-models/data.ts";
import { assessTax } from "#shared/tax/assessment.ts";
import {
  TAX_EVENTS,
  TAX_NODES,
  type TaxMachineEvent,
  type TaxMachineState,
  taxNodeOf,
} from "#shared/tax/machine-spec.ts";
import type { TaxAssessment } from "#shared/tax/types.ts";

const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** One independent oracle sum: lines at their gross, modifiers at their delta. */
const sumMinor = (
  lines: readonly { gross: number }[],
  modifiers: readonly { delta: number }[],
): number =>
  lines.reduce((sum, line) => sum + line.gross, 0) +
  modifiers.reduce((sum, item) => sum + item.delta, 0);

/** Independent arithmetic oracle only for these small integer representatives. */
export const validVatAssessment = (value: TaxAssessment): boolean => {
  const listed = sumMinor(value.basis.lines, value.basis.modifiers);
  const policy = value.policy;
  const tax =
    policy.mode === "none"
      ? 0
      : Math.round(
          (listed * policy.rateBasisPoints) /
            (policy.mode === "add_to_total"
              ? 10000
              : 10000 + policy.rateBasisPoints),
        );
  const income = sumMinor(value.lines, value.modifiers);
  return (
    value.taxableTotal === listed &&
    value.taxAmount === tax &&
    value.total === listed + (policy.mode === "add_to_total" ? tax : 0) &&
    income + tax === value.total &&
    value.lines.length === value.basis.lines.length &&
    value.modifiers.length === value.basis.modifiers.length &&
    value.lines.every(
      (line, index) =>
        line.listingId === value.basis.lines[index]!.listingId &&
        Number.isSafeInteger(line.gross) &&
        line.gross >= 0 &&
        line.gross <= value.basis.lines[index]!.gross,
    ) &&
    value.modifiers.every((item, index) => {
      const original = value.basis.modifiers[index]!;
      return (
        item.modifierId === original.modifierId &&
        Number.isSafeInteger(item.delta) &&
        (original.delta <= 0
          ? item.delta === original.delta
          : item.delta >= 0 && item.delta <= original.delta)
      );
    })
  );
};

const fields = {
  ...moveFields,
  accepted: "Bool",
  arithmetic: "Bool",
  assessmentCorrect: "Bool",
  basisKept: "Bool",
  noProviderCall: "Bool",
  refusalCorrect: "Bool",
  revisionCorrect: "Bool",
  safe: "Bool",
  settingCorrect: "Bool",
  terminal: "Bool",
} as const;
export type VatAttempt = TlaFact<typeof fields> & {
  readonly sampleTag: string;
};

const laws = (
  before: TaxMachineState,
  after: TaxMachineState,
  event: TaxMachineEvent,
  accepted: boolean,
) => {
  const changedPolicy = !equal(
    before.booking.assessment.policy,
    before.setting,
  );
  const changes =
    before.booking.kind === "active" &&
    (event.action === "refund" || (event.action === "save" && changedPolicy));
  const expectedAssessment =
    event.action === "save" && before.booking.kind === "active"
      ? assessTax(before.booking.assessment.basis, before.setting)
      : before.booking.assessment;
  return {
    arithmetic: validVatAssessment(after.booking.assessment),
    assessmentCorrect: equal(
      after.booking.assessment,
      accepted ? expectedAssessment : before.booking.assessment,
    ),
    basisKept: equal(
      before.booking.assessment.basis,
      after.booking.assessment.basis,
    ),
    noProviderCall: !event.movesMoney,
    refusalCorrect:
      accepted === !event.stale && (accepted || equal(before, after)),
    revisionCorrect:
      after.booking.revision ===
      before.booking.revision + Number(accepted && changes),
    settingCorrect: equal(
      after.setting,
      event.action === "setting" ? event.policy : before.setting,
    ),
    terminal:
      after.booking.kind ===
      (accepted && event.action === "refund"
        ? "refunded"
        : before.booking.kind),
  };
};

/** Retain every result, including unknown/unsafe targets and throwing mutations.
 * Never use the safety laws to decide which edges reach the checker. */
export const vatModel = () => {
  const attempts: VatAttempt[] = [];
  const initial: { state: string; safe: boolean; sampleTag: string }[] = [];
  for (const node of TAX_NODES)
    for (const rep of node.reps) {
      initial.push({
        safe: validVatAssessment(rep.state.booking.assessment),
        sampleTag: rep.tag,
        state: node.id,
      });
      for (const event of TAX_EVENTS) {
        const before = structuredClone(rep.state);
        const input = structuredClone(before);
        let after = input;
        let accepted = true;
        try {
          after = event.run(input);
        } catch {
          accepted = false;
        }
        const checks = laws(before, after, event, accepted);
        attempts.push({
          ...checks,
          accepted,
          eventId: event.id,
          safe: Object.values(checks).every(Boolean),
          sampleTag: rep.tag,
          sourceState: taxNodeOf(before),
          targetState: taxNodeOf(after),
        });
      }
    }
  return { attempts, initial };
};

/** Optional facts are a corruption-test seam; normal verification derives them live. */
export const vatModelData = async (model = vatModel()): Promise<string> =>
  tlaModule("VatLedgerData", [
    `VatStates == ${tlaSet(TAX_NODES.map((node) => node.id))}`,
    tlaRecords(
      "VatInitial",
      { safe: "Bool", state: "Str" },
      model.initial.map(({ state, safe }) => ({ safe, state })),
    ),
    tlaRecords(
      "VatAttempts",
      fields,
      model.attempts.map(({ sampleTag: _sampleTag, ...proof }) => proof),
    ),
  ]);
