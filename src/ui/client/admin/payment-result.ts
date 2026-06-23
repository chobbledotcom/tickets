/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Payment result pages: notify opener iframe via postMessage when in a popup. */
export const initPaymentResultNotifier = (): void => {
  const paymentResult = document.querySelector<HTMLElement>(
    "[data-payment-result]",
  );
  if (!paymentResult || !window.opener) return;

  const result = paymentResult.dataset.paymentResult;
  try {
    window.opener.postMessage(
      { type: result === "success" ? "payment-success" : "payment-cancel" },
      location.origin,
    );
  } catch {
    // opener may be cross-origin or closed
  }
};
