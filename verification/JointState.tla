----------------------------- MODULE JointState -----------------------------
(***************************************************************************)
(* The payment seam, proved: the product of the row machine and the refund *)
(* authority machine never reaches the two declared impossible joint       *)
(* states: send_armed on a row that holds no claim, and absent on a row    *)
(* whose claim is held.                                                    *)
(*                                                                         *)
(* The move tables are cut from verification/contract-snapshot.json, the   *)
(* dumped contracts of src/shared/payment/row-machine-spec.ts and          *)
(* src/shared/payment/refund-machine-spec.ts. A test fails when any        *)
(* machine drifts. Re-cut the tables then, and run 'deno task             *)
(* verify:models' again.                                                   *)
(*                                                                         *)
(* The row node "free" stands for the seam's free_reserved and             *)
(* free_finalized. The declared table gives both the same verdict, so the  *)
(* phase split adds nothing here. The authority axis uses the refund       *)
(* machine's nodes. The declared word "send_armed" is that machine's node  *)
(* of the same name.                                                       *)
(*                                                                         *)
(* Three guards carry the flows' coupling. They restate the two entries'   *)
(* reasons:                                                                *)
(* 1. A claim is admitted only over references that carry a charge.        *)
(* 2. A provider send is armed only under a held claim (arm and replay).   *)
(* 3. The claim is released only after the send completes. No settle event *)
(*    strips a claim while a send is mid-flight (send_armed or observing). *)
(***************************************************************************)
EXTENDS Integers, TLC

ClaimNodes == {"claim", "claim_review", "claim_review_unrecorded", "claim_unrecorded"}
MidSend == {"send_armed", "observing"}

SettleEvents == {
  "settle_release", "settle_recorded", "settle_found_unrecorded",
  "settle_open_partially_returned_obligation", "settle_open_shared_reference",
  "settle_retire_partially_returned_obligation", "settle_retire_shared_reference"
}

(* One move per dumped edge: source node, event, target node. *)
\* @type: Set(<<Str, Str, Str>>);
RowMoves == {
  << "free", "claim_granted", "claim" >>,
  << "free", "write_outcome", "settled" >>,
  << "claim", "settle_release", "free" >>,
  << "claim", "settle_recorded", "free" >>,
  << "claim", "settle_found_unrecorded", "unrecorded" >>,
  << "claim", "settle_open_partially_returned_obligation", "review" >>,
  << "claim", "settle_open_shared_reference", "review" >>,
  << "claim", "settle_retire_partially_returned_obligation", "free" >>,
  << "claim", "settle_retire_shared_reference", "free" >>,
  << "review", "claim_granted", "claim_review" >>,
  << "unrecorded", "claim_granted", "claim_unrecorded" >>,
  << "claim_review", "settle_release", "review" >>,
  << "claim_review", "settle_recorded", "review" >>,
  << "claim_review", "settle_found_unrecorded", "review_unrecorded" >>,
  << "claim_review", "settle_open_partially_returned_obligation", "review" >>,
  << "claim_review", "settle_open_shared_reference", "review" >>,
  << "claim_review", "settle_retire_partially_returned_obligation", "free" >>,
  << "claim_review", "settle_retire_shared_reference", "review" >>,
  << "claim_unrecorded", "settle_release", "unrecorded" >>,
  << "claim_unrecorded", "settle_recorded", "free" >>,
  << "claim_unrecorded", "settle_found_unrecorded", "unrecorded" >>,
  << "claim_unrecorded", "settle_open_partially_returned_obligation", "review_unrecorded" >>,
  << "claim_unrecorded", "settle_open_shared_reference", "review_unrecorded" >>,
  << "claim_unrecorded", "settle_retire_partially_returned_obligation", "unrecorded" >>,
  << "claim_unrecorded", "settle_retire_shared_reference", "unrecorded" >>,
  << "review_unrecorded", "claim_granted", "claim_review_unrecorded" >>,
  << "claim_review_unrecorded", "settle_release", "review_unrecorded" >>,
  << "claim_review_unrecorded", "settle_recorded", "review" >>,
  << "claim_review_unrecorded", "settle_found_unrecorded", "review_unrecorded" >>,
  << "claim_review_unrecorded", "settle_open_partially_returned_obligation", "review_unrecorded" >>,
  << "claim_review_unrecorded", "settle_open_shared_reference", "review_unrecorded" >>,
  << "claim_review_unrecorded", "settle_retire_partially_returned_obligation", "unrecorded" >>,
  << "claim_review_unrecorded", "settle_retire_shared_reference", "review_unrecorded" >>,
  << "settled", "write_outcome", "settled" >>
}

\* @type: Set(<<Str, Str, Str>>);
AuthMoves == {
  << "absent", "charge_created", "ready" >>,
  << "ready", "arm", "send_armed" >>,
  << "ready", "provider_returned", "returned" >>,
  << "ready", "unreadable", "choice_open" >>,
  << "ready", "conflict_returned", "choice_returned" >>,
  << "ready", "conflict_not_sent", "choice_not_sent" >>,
  << "ready", "conflict_wait", "check" >>,
  << "send_armed", "observe", "observing" >>,
  << "send_armed", "replay", "send_armed" >>,
  << "send_armed", "proved_not_sent", "ready" >>,
  << "send_armed", "provider_returned", "returned" >>,
  << "send_armed", "rejected", "choice_open" >>,
  << "send_armed", "expired", "choice_open" >>,
  << "send_armed", "possibly_sent", "choice_open" >>,
  << "send_armed", "conflict_returned", "choice_returned" >>,
  << "send_armed", "conflict_not_sent", "choice_not_sent" >>,
  << "send_armed", "conflict_wait", "check" >>,
  << "observing", "observe", "observing" >>,
  << "observing", "replay", "send_armed" >>,
  << "observing", "proved_not_sent", "ready" >>,
  << "observing", "provider_returned", "returned" >>,
  << "observing", "rejected", "choice_open" >>,
  << "observing", "expired", "choice_open" >>,
  << "observing", "possibly_sent", "choice_open" >>,
  << "observing", "conflict_returned", "choice_returned" >>,
  << "observing", "conflict_not_sent", "choice_not_sent" >>,
  << "observing", "conflict_wait", "check" >>,
  << "check", "provider_returned", "returned" >>,
  << "check", "conflict_returned", "choice_returned" >>,
  << "check", "conflict_not_sent", "choice_not_sent" >>,
  << "check", "conflict_wait", "check" >>,
  << "choice_open", "provider_returned", "returned" >>,
  << "choice_open", "conflict_returned", "choice_returned" >>,
  << "choice_open", "conflict_not_sent", "choice_not_sent" >>,
  << "choice_open", "conflict_wait", "check" >>,
  << "choice_open", "owner_confirms_returned", "returned" >>,
  << "choice_open", "owner_confirms_not_sent", "ready" >>,
  << "choice_not_sent", "owner_confirms_not_sent", "ready" >>,
  << "choice_returned", "owner_confirms_returned", "returned" >>,
  << "returned", "record_in_money", "recorded" >>
}

VARIABLES
  \* @type: Str;
  row,
  \* @type: Str;
  auth

(* Coupling 1 and coupling 3. *)
\* @type: (<<Str, Str, Str>>) => Bool;
RowEnabled(m) ==
  /\ m[1] = row
  /\ \/ m[2] # "claim_granted" \/ auth # "absent"
  /\ \/ ~(m[2] \in SettleEvents) \/ ~(auth \in MidSend)

(* Coupling 2: a send is armed only under a held claim. *)
\* @type: (<<Str, Str, Str>>) => Bool;
AuthEnabled(m) ==
  /\ m[1] = auth
  /\ \/ m[3] # "send_armed" \/ row \in ClaimNodes

RowStep == \E m \in RowMoves : RowEnabled(m) /\ row' = m[3] /\ auth' = auth
AuthStep == \E m \in AuthMoves : AuthEnabled(m) /\ auth' = m[3] /\ row' = row
Stutter == row' = row /\ auth' = auth

Init == row = "free" /\ auth = "absent"
Next == RowStep \/ AuthStep \/ Stutter

(* The two declared impossible joint states, as one invariant. *)
SeamOK ==
  /\ \/ auth # "send_armed" \/ row \in ClaimNodes
  /\ \/ auth # "absent" \/ row \notin ClaimNodes

=============================================================================
