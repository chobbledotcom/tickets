/** The declared row machine: for each node, the events that must move it
 * and where to. Every other (event × shape) pair must refuse. Settlements
 * refuse rows they do not hold, a held or settled row refuses a fresh
 * hold, and a terminal outcome refuses live work.
 *
 * The table declares what the mirror test and the graph suites hold the
 * real row functions to. Production reads the machine through the schema
 * atlas, which imports only the nodes, events, and node lookup. */

import type { RowEventId, RowNodeId } from "#payment/row-machine-spec.ts";
import type { MachineMoves } from "#shared/schema-atlas/machine-spec.ts";

export const EXPECTED_MOVES: MachineMoves<RowNodeId, RowEventId> = {
  claim: {
    settle_found_unrecorded: "unrecorded",
    settle_open_partially_returned_obligation: "review",
    settle_open_shared_reference: "review",
    settle_recorded: "free",
    settle_release: "free",
    settle_retire_partially_returned_obligation: "free",
    settle_retire_shared_reference: "free",
  },
  claim_review: {
    settle_found_unrecorded: "review_unrecorded",
    settle_open_partially_returned_obligation: "review",
    settle_open_shared_reference: "review",
    settle_recorded: "review",
    settle_release: "review",
    settle_retire_partially_returned_obligation: "free",
    settle_retire_shared_reference: "review",
  },
  claim_review_unrecorded: {
    settle_found_unrecorded: "review_unrecorded",
    settle_open_partially_returned_obligation: "review_unrecorded",
    settle_open_shared_reference: "review_unrecorded",
    settle_recorded: "review",
    settle_release: "review_unrecorded",
    settle_retire_partially_returned_obligation: "unrecorded",
    settle_retire_shared_reference: "review_unrecorded",
  },
  claim_unrecorded: {
    settle_found_unrecorded: "unrecorded",
    settle_open_partially_returned_obligation: "review_unrecorded",
    settle_open_shared_reference: "review_unrecorded",
    settle_recorded: "free",
    settle_release: "unrecorded",
    settle_retire_partially_returned_obligation: "unrecorded",
    settle_retire_shared_reference: "unrecorded",
  },
  free: {
    claim_granted: "claim",
    write_outcome: "settled",
  },
  review: {
    claim_granted: "claim_review",
  },
  review_unrecorded: {
    claim_granted: "claim_review_unrecorded",
  },
  // The conservative-then-final outcome write can replace itself. Nothing
  // else moves a row that ended.
  settled: {
    write_outcome: "settled",
  },
  unrecorded: {
    claim_granted: "claim_unrecorded",
  },
};
