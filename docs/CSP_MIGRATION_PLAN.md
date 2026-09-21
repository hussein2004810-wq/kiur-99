# KIUR CSP Migration Plan

## Status and boundary

The Worker applies its security headers globally in
`src/middleware/security-headers.ts`, before the public SPA routes are served
from `src/routes/static.ts`.  The current policy deliberately retains
`'unsafe-inline'` in `script-src` and `style-src` because removing it today
would break the served applications.

This is a local implementation plan.  It does not authorize a production
deployment or any Cloudflare configuration change.

## Measured baseline (2026-09-21)

| Surface | Inline script blocks | External scripts | Inline event attributes | Inline style attributes |
| --- | ---: | ---: | ---: | ---: |
| `public/nabd-home-quiz-prototype.html` | 1 | 1 | 176 | 286 |
| `public/nabd-admin-dashboard.html` | 1 | 0 | 155 | 381 |
| Total | 2 | 1 | 331 | 667 |

The external script on the student surface is the Google Identity loader; it is
not an inline script and is already explicitly allowlisted by `script-src`.

The dynamic handler arguments in both applications are now encoded with
`jsArg`; this protects quoted inline-handler boundaries but is not a
replacement for CSP migration.

## Execution phases

### Phase 1 — Establish external module entry points

- Completed foundation: `wrangler.toml` now binds `ASSETS` to `./public`, and
  `src/routes/static.ts` already fetches both SPA documents through it when
  available.  A dry build confirmed the binding and read the public assets.
- Choose one implementation deliberately: configure a Worker Assets binding
  for versioned static modules (now selected), or add a reviewed same-origin
  Worker route which serves compiled module text with `Content-Type:
  text/javascript`.  Do not use a third-party CDN for application code.
- Create one external module per SPA and load it with `<script type="module"
  src="...">`.
- Move the existing script bodies without changing runtime behaviour.
- Export only a small boot function; keep DOM queries and API configuration in
  the module.
- Acceptance: both pages load in local preview; script parsing and the full
  Worker suite pass; the module URL responds with JavaScript and no new inline
  script blocks are introduced.

### Phase 2 — Replace inline event handlers

- Add delegated click/change/submit listeners at stable page roots.
- Use `data-action` and `data-id` attributes; IDs must be written through a
  safe attribute encoder and read as plain strings.
- Migrate by feature slice, beginning with authentication, account recovery,
  payment/order actions, destructive admin actions, and content workflow
  controls.
- Keep server authorization as the source of truth; a `data-action` never
  grants capability.
- Acceptance per slice: student and administrator flows are exercised in
  desktop and phone widths, with Arabic RTL, empty/error states, and a
  source-targeted regression test.

### Phase 3 — Replace inline styles

- Convert static visual declarations to CSS classes.
- For calculated values (widths, colors, visibility), use named CSS custom
  properties set through DOM APIs or an allowlisted class set—not raw style
  strings assembled from API data.
- Preserve light/dark and RTL variations while moving each component.
- Acceptance: no regression in both themes; no API-controlled value reaches a
  raw CSS declaration.

### Phase 4 — Tighten and enforce CSP

- After the measured counts are zero, remove `'unsafe-inline'` from
  `script-src`; remove it from `style-src` only after Phase 3.
- Use the browser console and CSP violation reports in isolated staging before
  production rollout.
- Confirm Google Identity and Google Fonts paths still function under the
  narrowed policy.
- Acceptance: staging smoke tests pass with no CSP violations, then run the
  full Worker suite and a manual student/admin verification before any
  user-authorized deployment.

## Stop conditions

- Do not remove either `'unsafe-inline'` token while any corresponding inline
  construct remains.
- Do not treat passing unit tests as evidence of mobile, RTL, or browser CSP
  success.
- Stop and restore the prior local revision if an authentication, examination,
  media, purchase, or destructive administration flow regresses.

## Production prerequisites outside this plan

The CSP migration does not replace the required production actions listed in
`SECURITY_REMEDIATION_DELIVERY.md`: replace the JWT secret and revoke sessions,
configure exact origins/mail/OAuth, back up and migrate D1, attach approved
private R2, and validate CI/load testing on isolated staging.
