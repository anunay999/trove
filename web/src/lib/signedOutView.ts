/** What a signed-out visitor sees: the landing (with its login) or the API-key form. */
export type SignedOutView = "landing" | "connect";

/**
 * The view a signed-out visitor starts on, and returns to after disconnecting
 * a key or entering one the server refuses.
 *
 * With Clerk, accounts are the way in and the key form is a fallback reached
 * from the landing. Without Clerk, a key is the only credential that exists, so
 * the key form is the default on every host. It used to be the default only on
 * `app.*` hosts, which left a self-hosted dashboard on localhost showing
 * "/v1/stats failed: 401" with nowhere to enter a key.
 *
 * Pure so it can be tested without a DOM.
 */
export function defaultSignedOutView(clerkEnabled: boolean): SignedOutView {
  return clerkEnabled ? "landing" : "connect";
}
