/** Bunny Edge Scripting stops an incoming request after this many subrequests. */
export const BUNNY_SUBREQUEST_LIMIT = 50;

/** A refund uses several database calls plus one payment-provider request. */
export const BULK_REFUND_LIMIT = 5;
