# wodify-openclaw

OpenClaw extension for booking CrossFit classes on [Wodify](https://www.wodify.com/) via pure HTTP — no browser automation.

Provides three agent tools:
- **`wodify_get_classes`** — fetch class schedule for any date (public, no auth)
- **`wodify_book_class`** — book a class by ID (handles login + membership automatically)
- **`wodify_check_access`** — check reservation eligibility and list memberships

## Setup

### 1. Install

```bash
# Development (symlink):
openclaw hooks install --link /path/to/wodify-openclaw

# Production:
openclaw hooks install /path/to/wodify-openclaw
```

### 2. Configure Environment

Create a `.env` file (gitignored) with your gym and account details:

```bash
WODIFY_GYM_SUBDOMAIN=<gym subdomain>       # e.g. "delraybeach"
WODIFY_EMAIL=<wodify account email>
WODIFY_PASSWORD=<wodify account password>
WODIFY_CUSTOMER_ID=<numeric gym/tenant ID>  # from login response
WODIFY_LOCATION_ID=<gym location ID>        # from browser DevTools
WODIFY_CUSTOMER_HEX=<hex gym identifier>    # from email lookup response
WODIFY_MEMBERSHIP_ID=<membership plan ID>   # from Wodify account
```

**How to find these values:**
- `WODIFY_GYM_SUBDOMAIN` — the subdomain in your Wodify URL (e.g. `delraybeach` from `delraybeach.wodify.com`)
- `WODIFY_CUSTOMER_HEX` — run the email lookup endpoint with your email; the `Customer` field in the response is the hex value
- `WODIFY_CUSTOMER_ID` — returned as `CustomerId` in the login response
- `WODIFY_LOCATION_ID` — inspect any schedule request in browser DevTools; look for `LocationId` in `clientVariables`
- `WODIFY_MEMBERSHIP_ID` — visible in the Wodify member portal under your plan details, or from the class access API response

### 3. Agent Config

Add the wodify tools to an agent's allowlist in `openclaw.json`:

```json
{
  "agents": {
    "list": [
      {
        "id": "wodify",
        "workspace": "~/.openclaw/workspace-wodify",
        "tools": { "allow": ["wodify"] }
      }
    ]
  }
}
```

### 4. Cron (Optional)

Auto-book tomorrow's class every evening:

```bash
openclaw cron add \
  --name "Book gym class" \
  --cron "0 19 * * 0-4" \
  --tz "America/New_York" \
  --agent wodify \
  --session isolated \
  --message "Book tomorrow's CrossFit class." \
  --announce \
  --channel slack
```

## Development

```bash
npm install
npm run build     # Compile TypeScript
npm run dev       # Watch mode
npm run lint      # Type-check without emitting
```

### Testing

```bash
npx tsx test-smoke.ts [YYYY-MM-DD]     # Fetch schedule + login test
npx tsx test-book-7am.ts [YYYY-MM-DD]  # Book CrossFit 7AM (real booking!)
```

## How It Works

The extension communicates with Wodify's OutSystems Reactive backend via JSON screen service actions. The API was reverse-engineered from the Wodify SPA's network requests.

### Booking Flow

1. **Bootstrap session** — generate UUIDs, throwaway POST to get CSRF token
2. **Login** (two-step) — email lookup → password auth
3. **Get schedule** — fetch classes with `clientVariables` + `LocationId` (public, no auth needed)
4. **Book** — submit reservation with class ID and membership ID

## Known Limitations

- API version hashes are hardcoded and will break when Wodify deploys updates
- `getClassAccess` endpoint returns empty — membership ID must be configured manually
- Waitlist joining is detected but not yet implemented
- Session re-auth on expiration is not yet handled
