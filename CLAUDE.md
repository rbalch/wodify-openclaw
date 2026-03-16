# CLAUDE.md

## Project Overview

OpenClaw extension that books CrossFit classes on Wodify via pure HTTP (no browser automation). Three tools: `wodify_get_classes`, `wodify_book_class`, `wodify_check_access`.

Full end-to-end flow verified 2026-03-14: session bootstrap → login → schedule fetch → class booking. Successfully booked CrossFit 7:00 AM on 2026-03-16 twice via API — confirmed in Wodify account.

## Architecture

- `index.ts` — entry point, registers tools with OpenClaw plugin API
- `src/wodify-client.ts` — HTTP client: session bootstrap, CSRF, login, schedule, booking
- `src/tools.ts` — OpenClaw tool definitions with Typebox parameter schemas
- `src/types.ts` — TypeScript types for API shapes, `WodifyClientVariables`, `WodifyPluginConfig`
- `SKILL.md` — agent instructions for when/how to use the tools
- `openclaw.plugin.json` — plugin manifest with config schema
- `test-smoke.ts` — smoke test (schedule + login)
- `test-book-7am.ts` — end-to-end booking test (login → schedule → find 7AM → book)

## Verified Working Flow

```
1. initSession()     — generate osVisitor/osVisit UUIDs, throwaway POST to get CSRF
2. login()           — email lookup → ActionPrepare_LoginUser (validates creds)
3. getClasses(date)  — fetch schedule with clientVariables + LocationId
4. bookClass(id, membershipId) — book via inputParameters
```

**Membership ID** comes from `WODIFY_MEMBERSHIP_ID` env var. The `getClassAccess` endpoint that would discover this dynamically returns `{}` — needs further work on its `screenData.variables` structure. Not blocking for single-user automation.

## Critical OutSystems Patterns

These are the hard-won lessons from reverse engineering the Wodify SPA. Future you will thank past you for reading this.

### Session Bootstrap
Generate random `osVisitor`/`osVisit` UUIDs as cookies. Make a throwaway POST to any screenservices endpoint — the 403 response sets `nr1W_Theme_UI` and `nr2W_Theme_UI` cookies containing the CSRF token.

### CSRF Token
Extracted from `nr2W_Theme_UI` cookie. Format is `crf=TOKEN;uid=0;unm=` — **semicolon-separated key=value pairs, URL-encoded.** NOT JSON. Sent as `x-csrftoken` header.

### `clientVariables` (the big one)
Every `screenData`-based request **MUST** include a top-level `clientVariables` field with all 8 fields. Values come from env vars (`WODIFY_CUSTOMER_ID`, `WODIFY_LOCATION_ID`, `WODIFY_CUSTOMER_HEX`):
```json
{
  "IsInMembershipsFlow": false,
  "CustomerId": "<WODIFY_CUSTOMER_ID>",
  "LocationId": "<WODIFY_LOCATION_ID>",
  "LoggedInGuardianId_Deprecated": "0",
  "Customer": "<WODIFY_CUSTOMER_HEX>",
  "PrefilledEmail": "",
  "IsHeaderReady": true,
  "IsWebIntegration": false
}
```
- Without `clientVariables`: server crashes with `NullReferenceException`
- With empty `{}`: no crash, but 0 results
- With all 8 fields: works

### `SelectedLocationId` + `LocationId`
Must be in `screenData.variables` for schedule queries. Without them, returns empty list with no error. This was the final puzzle piece — took hours to discover.

### Login is "Prepare"
`ActionPrepare_LoginUser` validates credentials. Cookies stay `lid=Anonymous;uid=0` — this is normal. Auth works server-side anyway. Booking succeeds despite anonymous-looking cookies.

### Two Customer IDs
- `CustomerId` (`WODIFY_CUSTOMER_ID`) — numeric, used in login `inputParameters`
- `Customer` (`WODIFY_CUSTOMER_HEX`) — hex, used in booking and `clientVariables`

### API Version Hashes
`moduleVersion`/`apiVersion` are OutSystems deployment hashes. They break when Wodify deploys. Current `moduleVersion`: `H_wOuQ5lnJnuPk1WWtvFWw`. Discoverable via `GET /moduleservices/moduleversioninfo`.

## Config

Environment variables (`.env`, gitignored):

```
WODIFY_GYM_SUBDOMAIN=<gym subdomain, e.g. "delraybeach">
WODIFY_EMAIL=<wodify account email>
WODIFY_PASSWORD=<wodify account password>
WODIFY_CUSTOMER_ID=<numeric gym/tenant ID — from login response CustomerId field>
WODIFY_LOCATION_ID=<gym location ID — from browser DevTools network tab>
WODIFY_CUSTOMER_HEX=<hex gym identifier — from email lookup response Customer field>
WODIFY_MEMBERSHIP_ID=<active membership plan ID — from Wodify account or getClassAccess response>
```

To find these values: run the email lookup endpoint with your email — it returns `Customer` (hex). The login response returns `CustomerId` (numeric). `LocationId` can be found in browser DevTools by inspecting any schedule request's `clientVariables`. `MembershipId` is visible in the Wodify member portal or from the class access API.

## Commands

```bash
npm run build                          # Compile TypeScript
npm run dev                            # Watch mode
npm run lint                           # Type-check
npx tsx test-smoke.ts [YYYY-MM-DD]     # Smoke test (schedule + login)
npx tsx test-book-7am.ts [YYYY-MM-DD]  # Book CrossFit 7AM (real booking!)
```

## Code Style

- TypeScript strict mode
- ESM modules (`"type": "module"`)
- Single quotes, trailing commas, 100-char width, 2-space indent
- Typebox for JSON Schema parameter definitions

## Open Items

- **`getClassAccess` returns `{}`** — needs correct `screenData.variables` fields. Bypassed with hardcoded membership ID for now.
- **Version hash staleness** — no auto-recovery yet. When Wodify deploys, hashes change and requests fail.
- **OpenClaw integration** — tools registered but not wired into OpenClaw agent/cron yet.

## Reference

Full API reverse engineering notes: `/workspace/docs/wodify-api-notes.md`
