/** Capacity-related attendee creation failure reasons. */
export type CapacityErrorReason = "capacity_exceeded" | "encryption_error";

/**
 * Build a formatter for capacity-related attendee creation errors.
 * Returns a function `(reason, listingName) => message` that picks one of three
 * messages based on the failure reason and whether a listing name is known.
 */
export const capacityErrorFormatter =
  (messages: {
    /** Returned when the failure isn't capacity-related (e.g. encryption_error). */
    fallback: string;
    /** Returned for capacity_exceeded when no listing name is available. */
    generic: string;
    /** Returned for capacity_exceeded with a known listing name. */
    withName: (name: string) => string;
  }) =>
  (reason: CapacityErrorReason, listingName = ""): string => {
    if (reason !== "capacity_exceeded") return messages.fallback;
    return listingName ? messages.withName(listingName) : messages.generic;
  };
