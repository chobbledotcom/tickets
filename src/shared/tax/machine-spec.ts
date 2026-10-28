/* jscpd:ignore-start */
import {
  type MachineEvent,
  type MachineNode,
  machineRep,
} from "#shared/schema-atlas/machine-spec.ts";
import { assessTax } from "#shared/tax/assessment.ts";
import {
  reassessTax,
  refundTax,
  type TaxState,
} from "#shared/tax/transitions.ts";
import { NO_TAX, type TaxBasis, type TaxPolicy } from "#shared/tax/types.ts";
/* jscpd:ignore-end */

/** Settings are not booking state: changing them never rewrites an assessment. */
export type TaxMachineState = { booking: TaxState; setting: TaxPolicy };
export type TaxNodeId = TaxState["kind"];
export const taxNodeOf = (state: TaxMachineState): TaxNodeId =>
  state.booking.kind;

export const TAX_POLICIES = [
  { id: "none", policy: NO_TAX },
  { id: "add", policy: { mode: "add_to_total", rateBasisPoints: 2000 } },
  {
    id: "included",
    policy: { mode: "calculate_from_total", rateBasisPoints: 2000 },
  },
  { id: "add_zero", policy: { mode: "add_to_total", rateBasisPoints: 0 } },
  {
    id: "included_zero",
    policy: { mode: "calculate_from_total", rateBasisPoints: 0 },
  },
  {
    id: "add_fraction",
    policy: { mode: "add_to_total", rateBasisPoints: 1751 },
  },
  {
    id: "included_fraction",
    policy: { mode: "calculate_from_total", rateBasisPoints: 1751 },
  },
] as const satisfies readonly { id: string; policy: TaxPolicy }[];

/** Half-cent, allocation ties, signed discounts/surcharges and empty totals. */
export const TAX_BASES: readonly { id: string; basis: TaxBasis }[] = [
  { basis: { lines: [{ gross: 3, listingId: 1 }], modifiers: [] }, id: "half" },
  {
    basis: {
      lines: [
        { gross: 1, listingId: 1 },
        { gross: 1, listingId: 2 },
      ],
      modifiers: [{ delta: 1, modifierId: 1 }],
    },
    id: "ties",
  },
  {
    basis: {
      lines: [
        { gross: 1001, listingId: 1 },
        { gross: 499, listingId: 2 },
      ],
      modifiers: [
        { delta: -137, modifierId: 1 },
        { delta: 63, modifierId: 2 },
      ],
    },
    id: "discount",
  },
  { basis: { lines: [{ gross: 0, listingId: 1 }], modifiers: [] }, id: "zero" },
];

type SettingEventId = `setting_${(typeof TAX_POLICIES)[number]["id"]}`;
export type TaxEventId =
  | SettingEventId
  | "save"
  | "save_stale"
  | "refund"
  | "refund_stale";
export type TaxMachineEvent = MachineEvent<TaxMachineState, TaxEventId> & {
  action: "setting" | "save" | "refund";
  stale: boolean;
  policy?: TaxPolicy;
};
const event = (
  id: TaxEventId,
  action: TaxMachineEvent["action"],
  stale: boolean,
  run: TaxMachineEvent["run"],
  policy?: TaxPolicy,
): TaxMachineEvent => ({
  action,
  actor: "owner",
  id,
  labelKey: `schema.vat.edge.${id}`,
  movesMoney: false,
  ...(policy === undefined ? {} : { policy }),
  run,
  stale,
});
export const TAX_EVENTS: readonly TaxMachineEvent[] = [
  ...TAX_POLICIES.map(({ id, policy }) =>
    event(
      `setting_${id}`,
      "setting",
      false,
      (state) => ({ ...state, setting: policy }),
      policy,
    ),
  ),
  ...([false, true] as const).flatMap((stale) => [
    event(stale ? "save_stale" : "save", "save", stale, (state) => ({
      ...state,
      booking: reassessTax(
        state.booking,
        state.setting,
        state.booking.revision - Number(stale),
      ).after,
    })),
    event(stale ? "refund_stale" : "refund", "refund", stale, (state) => ({
      ...state,
      booking: refundTax(state.booking, state.booking.revision - Number(stale)),
    })),
  ]),
];

export const TAX_NODES: readonly MachineNode<TaxMachineState, TaxNodeId>[] = (
  ["active", "refunded"] as const
).map((kind) => ({
  id: kind,
  reps: TAX_BASES.flatMap(({ id, basis }) =>
    TAX_POLICIES.flatMap((held) =>
      TAX_POLICIES.flatMap((setting) =>
        [0, 2].map((revision) =>
          machineRep(`${id}/${held.id}/${setting.id}/${revision}`, {
            booking: {
              assessment: assessTax(basis, held.policy),
              kind,
              revision,
            },
            setting: setting.policy,
          }),
        ),
      ),
    ),
  ),
}));
