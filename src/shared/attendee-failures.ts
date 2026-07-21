import * as v from "valibot";

const NoLinesFailureReasonSchema = v.literal("no_lines");

/** Reasons an atomic attendee creation can reject a booking. */
export const AttendeeCreationFailureReasonSchema =
  v.literal("capacity_exceeded");
export type AttendeeCreationFailureReason = v.InferOutput<
  typeof AttendeeCreationFailureReasonSchema
>;

/** Reasons an atomic attendee edit can reject its desired booking lines. */
export const AttendeeUpdateFailureReasonSchema = v.union([
  AttendeeCreationFailureReasonSchema,
  NoLinesFailureReasonSchema,
]);
export type AttendeeUpdateFailureReason = v.InferOutput<
  typeof AttendeeUpdateFailureReasonSchema
>;

/** Every attendee write failure understood by the shared message formatter. */
export const AttendeeFailureReasonSchema = v.union([
  AttendeeCreationFailureReasonSchema,
  AttendeeUpdateFailureReasonSchema,
]);
export type AttendeeFailureReason = v.InferOutput<
  typeof AttendeeFailureReasonSchema
>;

type AttendeeFailureMessages = {
  fallback: string;
  generic: string;
  withName: (name: string) => string;
};

type FailureMessageBuilder = (
  messages: AttendeeFailureMessages,
  listingName: string,
) => string;

const capacityMessage: FailureMessageBuilder = (messages, listingName) =>
  listingName ? messages.withName(listingName) : messages.generic;
const fallbackMessage: FailureMessageBuilder = (messages) => messages.fallback;

const FAILURE_MESSAGE_BUILDERS: Record<
  AttendeeFailureReason,
  FailureMessageBuilder
> = {
  capacity_exceeded: capacityMessage,
  no_lines: fallbackMessage,
};

export type AttendeeFailureFormatter = (
  reason: AttendeeFailureReason,
  listingName?: string,
) => string;

/** Build a surface-specific formatter over the exhaustive failure schema. */
export const attendeeFailureFormatter =
  (messages: AttendeeFailureMessages): AttendeeFailureFormatter =>
  (reason, listingName = "") =>
    FAILURE_MESSAGE_BUILDERS[reason](messages, listingName);
