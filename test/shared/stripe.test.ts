// The Stripe SDK suites stay split by concern while this mirror entry gives
// targeted mutation one direct test for src/shared/stripe.ts.
import "../lib/stripe/config.test.ts";
import "../lib/stripe/connection.test.ts";
import "../lib/stripe/core.test.ts";
import "./stripe-provider.test.ts";
import "./stripe/webhook-cleanup.test.ts";
import "../lib/stripe/webhook-setup.test.ts";
import "./stripe/webhook.test.ts";
import "./stripe-checkout-close.test.ts";
