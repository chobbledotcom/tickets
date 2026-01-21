/**
 * Test setup - configures stripe-mock for integration tests
 *
 * Stripe integration tests require stripe-mock running on localhost:12111
 * Install: brew install stripe/stripe-mock/stripe-mock
 * Run: stripe-mock
 */

// Configure stripe-mock for all tests by default
process.env.STRIPE_MOCK_HOST = process.env.STRIPE_MOCK_HOST || "localhost";
process.env.STRIPE_MOCK_PORT = process.env.STRIPE_MOCK_PORT || "12111";
