# @handsoff/legacy-bank

A stand-in for the real thing: **ACME CoreTeller**, a fictional vendor core-banking product as deployed by two fictional institutions (variant A "First Example Credit Union", variant B "Sample Federal Credit Union"). All data is synthetic.

Deliberately hostile to automation, because that is the environment the brief describes:

- HTML 4.01 frameset: a `nav` frame and a `main` frame (`content` on variant B). Every page after sign-in lives inside a frame.
- Table-based layouts. Form fields have no `<label>`, no `id`, no `data-testid`; the only way to find "the member number box" is the text in the cell next to it.
- Buttons are `<input type="submit">` with a `value`; links are plain `<a>`.
- Obscure field names (`mno`, `acct_type`), server-rendered forms, full page loads.
- Cookie session with a configurable lifetime; an expired session bounces to sign-in with a notice.

Flows: sign in → Member Lookup → Search Results → Member Detail (accounts table) → Open Sub-Account → Confirmation.

Runtime conditions the replay engine must handle (chaos injection arrives in P4; the natural ones exist now): unknown member number shows "No matching member"; invalid sub-account form shows "Please correct the errors below."; an expired session shows "Your session has expired".

Do not add ids, labels or test hooks to make automation easier. That defeats the point.

```
LEGACY_BANK_VARIANT=a|b        which institution to serve (default a)
LEGACY_BANK_PORT_A=4100        LEGACY_BANK_PORT_B=4101
LEGACY_BANK_USER / LEGACY_BANK_PASS
LEGACY_BANK_SESSION_TTL_MS=1800000
```
