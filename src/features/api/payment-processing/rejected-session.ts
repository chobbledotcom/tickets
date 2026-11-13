import {
  type ReserveSessionResult,
  releaseReservation,
  reserveSession,
} from "#db/processed-payments.ts";

/** A failed first store must release its empty reservation. A stored failure
 * no longer matches that release, so its held refund claim stays. */
export const withRejectedSession = async <Result>(
  sessionId: string,
  run: (reservation: ReserveSessionResult) => Result | Promise<Result>,
): Promise<Result> => {
  const reservation = await reserveSession(sessionId);
  try {
    return await run(reservation);
  } catch (error) {
    if (reservation.reserved) await releaseReservation(sessionId);
    throw error;
  }
};
