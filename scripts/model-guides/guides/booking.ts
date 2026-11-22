import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** The everyday story of a repeat payment callback. */
/* jscpd:ignore-start -- static data, not code */
export const bookingReplay: ModelGuide = {
  badOutcome:
    "A late callback books a second ticket. Or a callback refunds a live ticket after the temporary row disappears.",
  cast: [
    {
      meaning:
        "One checkout attempt. The same identity stands for its ledger event group and its temporary payment row.",
      term: "session",
    },
    {
      meaning:
        "One provider callback about that session. A replay answers from an earlier result and makes no new sale.",
      term: "delivery",
    },
    {
      meaning:
        "The durable record of money and amounts owed. unrecorded means no legs, booked means legs with a live attendee owner, and orphaned means legs with no live owner.",
      term: "ledger",
    },
    {
      meaning:
        "The temporary processed_payments row. none is absent, reserved is an unresolved reservation, and finalized is a successful result with its attendee id.",
      term: "row",
    },
    {
      meaning:
        "The number of abstract ticket creations for this session. The model allows zero or one.",
      term: "ticket count",
    },
    {
      meaning:
        "A model-only memory of the refund verdict. It starts true and stays false after one bad refund.",
      term: "no-refund flag",
    },
    {
      meaning:
        "One prepared delivery outcome from the producer. The fact is not an observed callback or SQL race.",
      term: "fact",
    },
  ],
  claim:
    "This page follows one paid session through repeat provider callbacks and temporary row loss. The session creates at most one ticket. No delivery refunds a live ticket. The durable ledger label agrees with the ticket count.",
  limits: [
    "The model uses one session and the three ledger labels, two of them with legs.",
    "It does not model amounts, provider request identity, or a real provider payload.",
    "It assumes the atomic boundary of the ticket write. It does not prove SQL atomicity or row locks.",
    "It does not prove that a callback or a cleanup ever occurs.",
  ],
  module: "BookingReplay",
  safety:
    "Every allowed state keeps the ticket count in step with the booked ledger label. Every delivery that starts on a booked ledger keeps the no-refund flag true.",
  steps: [
    {
      code: [
        {
          path: "src/shared/session-ledger.ts",
          symbol: "classifyBookingLedger",
        },
      ],
      rules: ["Init", "TypeOK"],
      title: "Start before the first delivery",
      values: [
        { name: "ledger", value: "unrecorded" },
        { name: "row", value: "none" },
        { name: "ticket count", value: "0" },
        { name: "no-refund flag", value: "TRUE" },
      ],
      what: "The model starts before any provider delivery. The classifier answers unrecorded when the session has no ledger legs. Init sets no temporary row and zero tickets.",
    },
    {
      code: [
        {
          path: "src/shared/session-ledger.ts",
          symbol: "classifyBookingLedger",
        },
        {
          path: "scripts/verify-models/booking.ts",
          symbol: "bookingReplayModelData",
        },
      ],
      rules: ["ReserveStep"],
      title: "A reservation claims the temporary row",
      values: [
        { name: "ledger", value: "unrecorded" },
        { name: "row before", value: "none" },
        { name: "row after", value: "reserved" },
        { name: "ticket count", value: "0" },
      ],
      what: "The reserve action exposes the gap after the session claims a row and before the outcome. Only an unrecorded session with no row can enter this gap. A duplicate delivery in this gap finds the reserved row and takes the held outcome from the producer table.",
    },
    {
      code: [
        {
          path: "src/shared/session-ledger.ts",
          symbol: "classifyBookingLedger",
        },
      ],
      rules: ["SettleReserved"],
      title: "A successful outcome adds one ticket",
      values: [
        { name: "ledger before", value: "unrecorded" },
        { name: "row before", value: "reserved" },
        { name: "ledger after", value: "booked" },
        { name: "row after", value: "finalized" },
        { name: "ticket count", value: "1" },
      ],
      what: "The success step writes the durable legs and the attendee owner. The classifier answers booked when the legs exist and the owner id is present. The step also finalizes the temporary row. The model assumes the batch boundary of these writes.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/booking.ts",
          symbol: "bookingReplayModelData",
        },
      ],
      rules: ["StaleCleanup", "DeleteRow"],
      title: "The temporary row can disappear",
      values: [
        { name: "cleanup", value: "reserved becomes none" },
        { name: "deletion", value: "finalized becomes none" },
        { name: "ledger", value: "booked" },
        { name: "ticket count", value: "1" },
      ],
      what: "Cleanup removes only a reserved row. Retention or operator deletion removes a finalized row. The model permits both losses as disturbances. The durable ledger stays booked and the ticket count stays one.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/booking.ts",
          symbol: "bookingReplayModelData",
        },
        {
          path: "scripts/verify-models/booking.ts",
          symbol: "deletedRowRefundData",
        },
      ],
      rules: ["DeliveryStep"],
      title: "A late callback replays and does not refund",
      values: [
        { name: "ledger before", value: "booked" },
        { name: "row before", value: "none" },
        { name: "ledger after", value: "booked" },
        { name: "row after", value: "finalized" },
        { name: "tickets added", value: "0" },
        { name: "refund", value: "FALSE" },
      ],
      what: "A late delivery finds a booked ledger and no row. It claims the absent row and heals the row to finalized. It adds no ticket and no refund. The producer transcribes this outcome for the pair. The deleted-row control corrupts the same pair with a refund, and the checker rejects it.",
    },
    {
      code: [
        {
          path: "src/shared/session-ledger.ts",
          symbol: "classifyBookingLedger",
        },
        {
          path: "scripts/verify-models/booking.ts",
          symbol: "duplicateBookingData",
        },
      ],
      rules: ["Next", "Safety", "RefundsWhenHonoured", "LedgerMatchesBookings"],
      title: "Safety joins the count, the label, and the verdict",
      values: [
        { name: "booked ledger", value: "The ticket count is at least one." },
        { name: "no legs", value: "The ticket count is zero." },
        {
          name: "unsafe refund",
          value:
            "The ledger before the delivery says booked and the fact refunds.",
        },
      ],
      what: "RefundsWhenHonoured calls a refund unsafe only when the ledger before the delivery says booked. LedgerMatchesBookings requires a booked label exactly when the count is at least one. Safety joins TypeOK, the no-refund flag, and that relation. Next permits a delivery, the reserve, the settle, either row loss, or no change. The duplicate control makes every delivery on a booked ledger book again, and the checker rejects it.",
    },
  ],
  title: "A repeat payment callback does not book a second ticket",
};

/** The everyday story of one ticket at a door. */
export const doorScan: ModelGuide = {
  badOutcome:
    "A scan admits more places than the booking owns, lowers an admitted count, or admits from a refunded row.",
  cast: [
    {
      meaning:
        "One customer order that records the places owned on one or more listings.",
      term: "booking",
    },
    {
      meaning: "One item that a visitor can book, such as an event.",
      term: "listing",
    },
    {
      meaning:
        "One unit of admission. Every count here is a whole number of places.",
      term: "place",
    },
    {
      meaning:
        "One attendee row. It supplies the customer quantity and the checked-in count for one listing.",
      term: "row",
    },
    {
      meaning:
        "The access record presented at the door, such as a QR code that identifies the booked rows.",
      term: "ticket",
    },
    {
      meaning:
        "The count that door staff request for one scan. It applies to each selected listing and stops at the unadmitted count.",
      term: "pick",
    },
    {
      meaning:
        "One prepared decision output from the producer. The fact is not a database write.",
      term: "fact",
    },
    {
      meaning:
        "A model-only flag. It starts TRUE and stays FALSE after one bad fact.",
      term: "all-facts-safe flag",
    },
  ],
  claim:
    "This page follows one ticket at a door. Each scan admits no more places than the booking owns on each listing. A refunded row, a purchase-only row, and an unverified non-transferable row admit nothing. A failed fact stays visible.",
  limits: [
    "The examples use listing one with three booked places and listing two with one.",
    "The facts cover the supplied picks, gates, and scope choices, not every combination.",
    "The model assumes the fixture flags represent the ticket. It does not prove staff authority or a real ID check.",
    "It does not prove the SQL admission write, concurrent scans, or listing order.",
  ],
  module: "DoorScan",
  safety:
    "Every allowed state keeps each listing total between zero and its booked quantity. The all-facts-safe flag stays false after one bad fact.",
  steps: [
    {
      code: [
        { path: "src/features/admin/scan-decision.ts", symbol: "decideScan" },
        {
          path: "scripts/verify-models/door-scan.ts",
          symbol: "representatives",
        },
      ],
      rules: ["Init", "TypeOK"],
      title: "Start with no admitted places",
      values: [
        { name: "listing one", value: "Three booked places, zero admitted." },
        { name: "listing two", value: "One booked place, zero admitted." },
        { name: "all-facts-safe flag", value: "TRUE" },
      ],
      what: "The model starts at a fresh door view. The producer names two representative listings with booked quantities of three and one. Init sets both admitted totals to zero and keeps the safe verdict.",
    },
    {
      code: [
        { path: "src/features/admin/scan-decision.ts", symbol: "decideScan" },
      ],
      rules: ["AdmitStep", "SafeAdmission"],
      title: "An excessive pick stops at the unadmitted count",
      values: [
        { name: "listing one booked", value: "3" },
        { name: "admitted before", value: "2" },
        { name: "pick", value: "5" },
        { name: "admitted after", value: "3" },
        { name: "places this scan admits", value: "1" },
      ],
      what: "The party owns three places and already used two. Door staff request five more. The decision caps the unit at the one place that remains. SafeAdmission requires the after count to stay within the booked quantity and to keep the before count.",
    },
    {
      code: [
        { path: "src/features/admin/scan-decision.ts", symbol: "scanAdmits" },
        { path: "src/features/admin/scan-decision.ts", symbol: "unitTickets" },
      ],
      rules: ["AdmitStep"],
      title: "A second listing admits its own place",
      values: [
        { name: "listing two booked", value: "1" },
        { name: "admitted before", value: "0" },
        { name: "pick", value: "1" },
        { name: "admitted after", value: "1" },
      ],
      what: "The scan selects listing two and admits its single owed place. A pick of one on two selected listings admits one place on each, not one place shared between them. The decision reports one unit for each selected listing.",
    },
    {
      code: [
        { path: "src/features/admin/scan-decision.ts", symbol: "decideScan" },
      ],
      rules: ["AdmitStep", "SafeAdmission"],
      title: "A gate keeps the count unchanged",
      values: [
        { name: "refunded row", value: "before 2, after 2" },
        { name: "non-transferable row without ID", value: "before 1, after 1" },
        { name: "purchase-only row", value: "before 0, after 0" },
        { name: "no quantity answer", value: "before 1, after 1" },
      ],
      what: "A refunded row grants no admission. A purchase-only listing sells with no door check-in. A non-transferable listing holds the place until the ID answer is true. A scan with more than one owed place and no quantity answer asks first. Each refusal keeps the count, so the fact adds no place.",
    },
    {
      code: [
        { path: "src/features/admin/scan-decision.ts", symbol: "decideScan" },
        {
          path: "scripts/verify-models/door-scan.ts",
          symbol: "representatives",
        },
      ],
      rules: ["Next", "Safety"],
      title: "Safety holds for every allowed scan",
      values: [
        { name: "listing one total", value: "0 to 3" },
        { name: "listing two total", value: "0 to 1" },
        { name: "all-facts-safe flag", value: "FALSE after one bad fact" },
      ],
      what: "AdmitStep selects a fact that matches the current count on its listing. It moves only that listing and keeps the other total. Next also permits no change. Safety joins TypeOK, the safe verdict, and the two count bounds. A bad fact leaves the flag false, so a later safe fact cannot erase the failure.",
    },
  ],
  title: "A door admits the right number of places",
};
/* jscpd:ignore-end */
