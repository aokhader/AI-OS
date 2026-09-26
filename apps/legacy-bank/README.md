# @handsoff/legacy-bank

A stand-in for the real thing: **ACME CoreTeller**, a fictional vendor core-banking product as deployed by two fictional institutions (variant A "First Example Credit Union", variant B "Sample Federal Credit Union"). All data is synthetic.

Deliberately hostile to automation, because that is the environment the brief describes:

- HTML 4.01 frameset: a `nav` frame and a `main` frame (`content` on variant B). Every page after sign-in lives inside a frame.
- Table-based layouts. Form fields have no `<label>`, no `id`, no `data-testid`; the only way to find "the member number box" is the text in the cell next to it.
- Buttons are `<input type="submit">` with a `value`; links are plain `<a>`.
- Obscure field names (`mno`, `acct_type`), server-rendered forms, full page loads.
- Cookie session with a configurable lifetime; an expired session bounces to sign-in with a notice.

Flows: sign in → Member Lookup → Search Results → Member Detail (accounts table) → Open Sub-Account → Confirmation.

Runtime conditions the replay engine must handle. The natural ones: an unknown member number shows "No matching member"; an invalid sub-account form shows "Please correct the errors below."; an expired session shows "Your session has expired". The injected ones (D-024): send `x-handsoff-chaos: <mode>[,<mode>]` and each armed mode fires once per browser on the request it targets, remembered in the `coreteller_chaos` cookie. `not-found`, `session-expiry`, `interstitial` (native `alert()` on the results page), `slow` (a busy page that refreshes to the results) and `error` (a 500 page) target the next member search; `validation` rejects the next otherwise valid sub-account submit. Honoured only when `LEGACY_BANK_ALLOW_CHAOS_HEADER` is not `false`.

Do not add ids, labels or test hooks to make automation easier. That defeats the point.

```
LEGACY_BANK_VARIANT=a|b        which institution to serve (default a)
LEGACY_BANK_PORT_A=4100        LEGACY_BANK_PORT_B=4101
LEGACY_BANK_USER / LEGACY_BANK_PASS
LEGACY_BANK_SESSION_TTL_MS=1800000
```
