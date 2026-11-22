import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** The everyday story of a parent and child that share a capped group. */
/* jscpd:ignore-start -- static data, not code */
export const sharedGroupCapacity: ModelGuide = {
  badOutcome:
    "A pool reports more pairs than its free places hold. Or a sold-out date-less pair passes the allow gate.",
  cast: [
    {
      meaning:
        "One item that a customer can book, such as an event or a session.",
      term: "listing",
    },
    {
      meaning: "One unit of bookable capacity. Every count here counts places.",
      term: "place",
    },
    {
      meaning:
        "One parent listing and its one required child. The pair uses two places from every group that both listings share.",
      term: "pair",
    },
    {
      meaning:
        "A common capacity limit that both listings share, such as a shared room.",
      term: "group",
    },
    {
      meaning:
        "The group total limit independent of date. A present zero allows no place.",
      term: "static cap",
    },
    {
      meaning:
        "The free-place count in the caller's date context. A missing value gives a dummy zero, not a full pool.",
      term: "free places",
    },
    {
      meaning:
        "Whole pairs that this abstract sale loop sells. One pair consumes two group places.",
      term: "sold",
    },
    {
      meaning:
        "One pure function output from the producer. The fact is not a database read.",
      term: "fact",
    },
  ],
  claim:
    "This page follows one parent listing and one required child that share a capped group. One pair uses two group places. The sale loop never reports more pairs than the pool holds. A static cap below two refuses the pair even when no date value exists.",
  limits: [
    "The examples use fixed group maps with caps and free counts from zero to ten.",
    "The model has one parent and one child, not a whole child-choice search.",
    "It does not prove group map completeness, SQL writes, or concurrent sales.",
    "It checks safety. It does not prove that stock sells out or that a buyer completes an order.",
  ],
  module: "SharedGroupCapacity",
  safety:
    "Every allowed state keeps each reported pair count within the free places, keeps the loop balance non-negative, and keeps a date-less pool with a cap below two at zero sales.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/shared-group-capacity.ts",
          symbol: "sharedGroupCapacityModelData",
        },
        { path: "src/shared/group-capacity.ts", symbol: "sharedGroupCapacity" },
      ],
      rules: ["Init", "TypeOK"],
      title: "Start with a pool of five free places",
      values: [
        { name: "group 11 free places", value: "5" },
        { name: "group 11 static cap", value: "10" },
        { name: "date-less", value: "FALSE" },
        { name: "static cap present", value: "TRUE" },
        { name: "sold", value: "0" },
      ],
      what: "The producer calls the capacity functions over fixed group maps. Init selects any supplied fact and starts its sale loop with zero pairs sold. The example starts on a shared group with five free places and a static cap of ten.",
    },
    {
      code: [
        {
          path: "src/shared/group-capacity.ts",
          symbol: "sharedGroupRemaining",
        },
        {
          path: "src/shared/group-capacity.ts",
          symbol: "PARENT_CHILD_GROUP_UNITS",
        },
      ],
      rules: ["SellStep"],
      title: "One pair consumes two places",
      values: [
        { name: "free places before", value: "5" },
        { name: "free places after", value: "3" },
        { name: "sold before", value: "0" },
        { name: "sold after", value: "1" },
        { name: "pairs that fit", value: "2" },
      ],
      what: "The remaining function takes the smallest value over the shared groups. One pair needs two places. The sell step checks the allow gate, at least two free places, and a sold count below the fit count. It then removes two places and adds one pair.",
    },
    {
      code: [
        { path: "src/shared/booking/model.ts", symbol: "ticketsThatFitInPool" },
      ],
      rules: ["SellStep"],
      title: "The pool stops at two pairs",
      values: [
        { name: "free places before", value: "3" },
        { name: "free places after", value: "1" },
        { name: "sold before", value: "1" },
        { name: "sold after", value: "2" },
        { name: "pairs that fit", value: "2" },
      ],
      what: "The fit function divides five free places by two and reports two whole pairs. A second sale leaves one free place. A third sale fails, because the loop already sold two pairs and one place cannot hold a pair.",
    },
    {
      code: [
        { path: "src/shared/booking/model.ts", symbol: "ticketsThatFitInPool" },
        {
          path: "scripts/verify-models/shared-group-capacity.ts",
          symbol: "FACTS",
        },
      ],
      rules: ["NoOverfill"],
      title: "Every fact must fit its pool",
      values: [
        { name: "group 24", value: "1 free place, 0 pairs" },
        { name: "group 25", value: "2 free places, 1 pair" },
        { name: "group 11", value: "5 free places, 2 pairs" },
      ],
      what: "NoOverfill reads every supplied fact with a free-place value. It multiplies the reported pair count by two and compares the result to the free places. It also requires a non-negative loop balance. A pool with one free place reports zero pairs.",
    },
    {
      code: [
        { path: "src/shared/group-capacity.ts", symbol: "sharedGroupCapacity" },
        {
          path: "src/shared/booking/model.ts",
          symbol: "parentAndChildFitGroup",
        },
      ],
      rules: ["NoDateLessSoldOutPair"],
      title: "A cap below two refuses a date-less pair",
      values: [
        { name: "group 23 static cap", value: "1" },
        { name: "group 23 date-less", value: "TRUE" },
        { name: "group 23 allowed", value: "FALSE" },
        { name: "group 23 sold", value: "0" },
        { name: "group 28 static cap", value: "absent" },
        { name: "group 28 allowed", value: "TRUE" },
      ],
      what: "A static cap below two refuses the pair even when no date value exists. The allow function treats a missing cap as unknown, not as zero. Group 28 has no static cap and five free places, so it still allows a pair. A date-less fact has a dummy free count of zero, so the sale loop sells no pair.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/shared-group-capacity.ts",
          symbol: "sharedGroupCapacityModelData",
        },
        { path: "src/shared/booking/model.ts", symbol: "ticketsThatFitInPool" },
      ],
      rules: ["Next", "Safety"],
      title: "Safety holds for every allowed sale",
      values: [
        { name: "free places", value: "Never below 0" },
        { name: "sold", value: "Never above the fit count" },
        {
          name: "context",
          value: "The cap and the date-less flags stay fixed",
        },
      ],
      what: "The sell step matches the fact context and requires the allow gate, two free places, and a sold count below the fit count. The fact free count must equal the loop balance plus two places for each pair already sold. Next also permits no change. Safety joins TypeOK, NoOverfill, and NoDateLessSoldOutPair. The loop can stop at any point, so the model does not prove that a sale finishes.",
    },
  ],
  title: "Parent and child pairs sold from a shared group pool",
};
/* jscpd:ignore-end */
