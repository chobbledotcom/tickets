/// <reference lib="dom" />
/** Admin page behaviors - bundled by build-static-assets.ts for strict CSP.
 *
 * Thin entry point: each behavior lives in its own module under ./admin/
 * and is wired up here. Modules are scoped to one concern and guard
 * themselves against missing DOM elements so they are safe to run on
 * every admin page. */

import { initCharCounters } from "./admin/char-counter.ts";
import { initCheckoutPopup } from "./admin/checkout-popup.ts";
import { initClosesAtAutofill } from "./admin/closes-at-autofill.ts";
import { initQuestionVisibility } from "./admin/custom-question-visibility.ts";
import { initDuplicatePreview } from "./admin/duplicate-preview.ts";
import { initEventDatePicker } from "./admin/event-date-picker.ts";
import { initFillDefaultTemplate } from "./admin/fill-default-template.ts";
import { initFormSubmitDisable } from "./admin/form-submit-disable.ts";
import { initIframeScrollIntoView } from "./admin/iframe-scroll-into-view.ts";
import { initManualCheckin } from "./admin/manual-checkin.ts";
import { initMultiBookingBuilder } from "./admin/multi-booking.ts";
import { initNavSelect } from "./admin/nav-select.ts";
import { initPaymentResultNotifier } from "./admin/payment-result.ts";
import { initPaymentTestButtons } from "./admin/payment-test-buttons.ts";
import { initQrRefresh } from "./admin/qr-refresh.ts";
import { initScrollHideNav } from "./admin/scroll-hide-nav.ts";
import { initSelectOnClick } from "./admin/select-on-click.ts";
import { initTicketQuantityRequired } from "./admin/ticket-quantity-required.ts";

initSelectOnClick();
initNavSelect();
initMultiBookingBuilder();
initFillDefaultTemplate();
initClosesAtAutofill();
initIframeScrollIntoView();
initCheckoutPopup();
initScrollHideNav();
initPaymentResultNotifier();
initPaymentTestButtons();
initQrRefresh();
initCharCounters();
initManualCheckin();
initFormSubmitDisable();
initQuestionVisibility();
initEventDatePicker();
initDuplicatePreview();
initTicketQuantityRequired();
