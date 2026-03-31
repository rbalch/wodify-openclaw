# CLAUDE.md

## Project Overview

OpenClaw extension that books CrossFit classes on Wodify via pure HTTP (no browser automation). Three tools: `wodify_get_classes`, `wodify_book_class`, `wodify_check_access`.

Full end-to-end flow verified 2026-03-14: session bootstrap → login → schedule fetch → class booking. Successfully booked CrossFit 7:00 AM on 2026-03-16 twice via API — confirmed in Wodify account.

## Architecture

- `index.ts` — entry point, registers tools with OpenClaw plugin API
- `src/wodify-client.ts` — HTTP client: session bootstrap, CSRF, login, schedule, booking
- `src/tools.ts` — OpenClaw tool definitions with Typebox parameter schemas
- `src/types.ts` — TypeScript types for API shapes, `WodifyClientVariables`, `WodifyPluginConfig`
- `discover.ts` — interactive config discovery: resolves all config values including membershipId automatically
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

**Membership ID** auto-renews monthly and changes. Use `npx tsx discover.ts` to resolve the current value (see "Membership Discovery" below).

## discover.ts — Config Discovery & Auto-Patching

Run `npx tsx discover.ts` to automatically discover all config values and patch `wodify-client.ts` with fresh API version hashes.

**What it does:**
1. Resolves `moduleVersion` + per-endpoint `apiVersion` hashes from live Wodify deployment JS files
2. Logs in and discovers `customerHex`, `customerId`, `locationId`
3. Fetches schedule (scans up to 7 days ahead to find a day with classes)
4. Discovers `membershipId` via the MembershipType screen data action chain (see below)
5. Auto-patches `src/wodify-client.ts` `VERSION_INFO` with fresh hashes
6. Outputs `.env` and `openclaw.json` config blocks

**When to run:**
- When bookings fail with "You do not have an active membership" (membershipId rotated)
- When API calls return unexpected errors (version hashes stale after Wodify deploy)
- After any Wodify outage or deploy

### Membership Discovery — The Hard-Won Lesson (2026-03-26)

The `DataActionGetClassAccess_InMembershipType` endpoint returns `MembershipsAvailable.List` with the active membership ID. But it **cannot be called cold** — it depends on output from a prior data action on the same OutSystems screen.

**What fails:** Calling `GetClassAccess` directly → `NullReferenceException` (server-side null because it reads class data from screen variables that were never populated).

**What works — two-step chain:**

1. **Call `DataActionGet_Class_InMembershipType`** first — returns class details (`Class`, `Class_EndTime`, `CoachDetails`, `Duration`, `UseSeparateDropInFee`). This call succeeds with basic screen variables.

2. **Merge its output into `screenData.variables`** as `Get_Class_InMembershipType` key, then call `DataActionGetClassAccess_InMembershipType` — server reads the class data from screen variables and returns `MembershipsAvailable.List`.

**Critical detail — two different `clientVariables` schemas:**

The Classes screen (schedule, LayoutTop) uses:
```json
{
  "IsInMembershipsFlow": false, "CustomerId": "...", "LocationId": 11090,
  "LoggedInGuardianId_Deprecated": "0", "Customer": "...",
  "PrefilledEmail": "", "IsHeaderReady": true, "IsWebIntegration": false
}
```

The MembershipType screen uses a completely different shape:
```json
{
  "PrefilledEmail": "", "LoggedIn_GlobalUserId": "...", "LoggedIn_UserName": "",
  "BookedForListSerialized": "", "TokenForCreatePassword": "",
  "LoggedIn_UserId": "...", "LoggedIn_LeadId": "0",
  "LoggedIn_CustomerId": "...", "OnlineMembershipSaleId": "0",
  "LoggedIn_Email": "..."
}
```

Sending the wrong schema → `NullReferenceException` or empty results. Each OutSystems module (`OnlineSalesPage` vs `OnlineSalesPage_CW`) has its own clientVariables shape.

**Screen variables that must be present** for `GetClassAccess`:
- `FilterProgramId`, `ClassId`, `LocationId`, `Customer` — identify the class
- `LoggedIn_UserId`, `LoggedIn_GlobalUserId`, `LoggedIn_Email` — identify the user
- `HasProgramAccess: true`, `SelectedMembershipId: "0"` — access flags
- `BookWithNewMembershipClicked: false`, `ShowBookingList: true` — UI state
- `Get_Class_InMembershipType: <output from step 1>` — the critical chained data
- `_classIdInDataFetchStatus: 1` (and similar `_*InDataFetchStatus: 1` flags) — tells server data was fetched

## Critical OutSystems Patterns

These are the hard-won lessons from reverse engineering the Wodify SPA. Future you will thank past you for reading this.

### Session Bootstrap
Generate random `osVisitor`/`osVisit` UUIDs as cookies. Make a throwaway POST to any screenservices endpoint — the 403 response sets `nr1W_Theme_UI` and `nr2W_Theme_UI` cookies containing the CSRF token.

### CSRF Token
Extracted from `nr2W_Theme_UI` cookie. Format is `crf=TOKEN;uid=0;unm=` — **semicolon-separated key=value pairs, URL-encoded.** NOT JSON. Sent as `x-csrftoken` header.

### `clientVariables` — Module-Specific Schemas
Every `screenData`-based request **MUST** include a top-level `clientVariables` field. **The schema differs per OutSystems module** — see "Membership Discovery" above for the two known schemas.

For the Classes screen (`OnlineSalesPage` module):
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
- With all fields: works

### OutSystems Data Action Chaining
Screen data actions can depend on outputs of other data actions on the same screen. When calling via API, you must:
1. Call upstream data actions first
2. Merge their `response.data` into `screenData.variables` under the data action's key name
3. Set `_*InDataFetchStatus: 1` flags for each resolved input
4. Then call the downstream data action

This is because OutSystems screen variables are a single shared state — the browser JS framework handles merging automatically, but direct API calls must do it manually.

### `SelectedLocationId` + `LocationId`
Must be in `screenData.variables` for schedule queries. Without them, returns empty list with no error.

### ProgramsList Must Be Populated
Schedule queries require `ProgramsList` and `SelectedProgramList` to contain actual program IDs. Empty lists return zero classes even when classes exist. Known program IDs: CrossFit=119335, Open Gym=119416, Off Hours=134852.

### Login is "Prepare"
`ActionPrepare_LoginUser` validates credentials. Cookies stay `lid=Anonymous;uid=0` — this is normal. Auth works server-side anyway. Booking succeeds despite anonymous-looking cookies.

### Two Customer IDs
- `CustomerId` (`WODIFY_CUSTOMER_ID`) — numeric, used in login `inputParameters`
- `Customer` (`WODIFY_CUSTOMER_HEX`) — hex, used in booking and `clientVariables`

### API Version Hashes
`moduleVersion`/`apiVersion` are OutSystems deployment hashes. They change when Wodify deploys updates. Discoverable via `GET /moduleservices/moduleversioninfo` (moduleVersion) and by parsing endpoint-specific JS files (apiVersion per endpoint).

**Auto-patching:** `discover.ts` resolves these dynamically and patches `src/wodify-client.ts` `VERSION_INFO` automatically. The regex extracts apiVersion hashes from JS source — hashes are alphanumeric+`=_-` (no `/`), which distinguishes them from endpoint paths.

### MembershipType Screen Endpoints (all in `OnlineSalesPage_CW.Classes.MembershipType.mvc`)
- `DataActionGet_InitialData_InMembershipType` — screen init (location details)
- `DataActionGet_Class_InMembershipType` — class details (must call before GetClassAccess)
- `DataActionGetClassAccess_InMembershipType` — membership access + available memberships
- `DataActionGet_ClassPlansAndPacks_InMembershipType` — plans/packs (also depends on class data)
- `ActionBookClassWithExistingMembership` — booking (inputParameters, not screenData)
- `ServiceAPICreateClassReservation` — alternative booking endpoint (unexplored)
- `ServiceAPICancelClassReservation` — cancel reservation
- `ServiceAPICancelSignIn` — cancel sign-in

## Config

Environment variables (`.env`, gitignored):

```
WODIFY_GYM_SUBDOMAIN=<gym subdomain, e.g. "delraybeach">
WODIFY_EMAIL=<wodify account email>
WODIFY_PASSWORD=<wodify account password>
WODIFY_CUSTOMER_ID=<numeric gym/tenant ID — from login response CustomerId field>
WODIFY_LOCATION_ID=<gym location ID — from LayoutTop initial data>
WODIFY_CUSTOMER_HEX=<hex gym identifier — from email lookup response Customer field>
WODIFY_MEMBERSHIP_ID=<active membership plan ID — auto-discovered by discover.ts>
```

All values discoverable automatically via `npx tsx discover.ts`. The membershipId rotates on membership renewal (monthly for auto-renew plans).

## Commands

```bash
npm run build                          # Compile TypeScript
npm run dev                            # Watch mode
npm run lint                           # Type-check
npx tsx discover.ts                    # Discover all config values + patch version hashes
npx tsx test-smoke.ts [YYYY-MM-DD]     # Smoke test (schedule + login)
npx tsx test-book-7am.ts [YYYY-MM-DD]  # Book CrossFit 7AM (real booking!)
```

## Code Style

- TypeScript strict mode
- ESM modules (`"type": "module"`)
- Single quotes, trailing commas, 100-char width, 2-space indent
- Typebox for JSON Schema parameter definitions

## Open Items

- **Auto-run discover.ts on booking failure** — when cron reports "no active membership", automatically re-discover membershipId and update config. Currently requires manual intervention.
- **`check_access` tool in tools.ts still broken** — uses the old single-call approach to `GetClassAccess` which NullRefs. Should be updated to use the two-step chain from discover.ts.
- **Version hash auto-recovery in wodify-client.ts** — could detect stale hashes at runtime and re-resolve via `/moduleservices/moduleversioninfo` instead of requiring discover.ts.

## Reference

Full API reverse engineering notes: `/workspace/docs/wodify-api-notes.md`
