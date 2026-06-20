/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Stripe checkout popup: opens Stripe in a new window when embedded in an iframe.
 * No-JS fallback: the Pay Now link has target="_blank" and works as a plain link. */
export const initCheckoutPopup = (): void => {
  const checkoutPopup = document.querySelector<HTMLElement>(
    "[data-checkout-popup]",
  );
  if (!checkoutPopup) return;

  const checkoutUrl = checkoutPopup.dataset.checkoutPopup!;
  const waitingEl = checkoutPopup.querySelector<HTMLElement>(
    "[data-checkout-waiting]",
  )!;
  const openLink = checkoutPopup.querySelector<HTMLAnchorElement>(
    "[data-open-checkout]",
  )!;
  let popup: Window | null = null;

  const showPayButton = () => {
    waitingEl.hidden = true;
    openLink.parentElement!.hidden = false;
  };

  // Listen for postMessage from the popup success/cancel page
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    if (e.data?.type === "payment-success") {
      // Navigate the iframe to the real success page — single code path
      location.href = "/ticket/reserved";
    } else if (e.data?.type === "payment-cancel") {
      showPayButton();
    }
  });

  // Track popup and detect when it closes without completing
  const pollPopup = () => {
    if (!popup || popup.closed) {
      showPayButton();
      return;
    }
    setTimeout(pollPopup, 500);
  };

  openLink.addEventListener("click", (e) => {
    // Open without noopener so the popup can access window.opener for postMessage
    const w = window.open(checkoutUrl, "_blank");
    if (w) {
      e.preventDefault();
      popup = w;
      openLink.parentElement!.hidden = true;
      waitingEl.hidden = false;
      pollPopup();
    }
    // If popup blocked (w is null), default link action fires — graceful fallback
  });
};
