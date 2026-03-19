# wodify-openclaw

OpenClaw extension for booking CrossFit classes on [Wodify](https://www.wodify.com/) via pure HTTP — no browser automation.

Provides three agent tools:
- **`wodify_get_classes`** — fetch class schedule for any date (public, no auth)
- **`wodify_book_class`** — book a class by ID (handles login + membership automatically)
- **`wodify_check_access`** — check reservation eligibility and list memberships

## Setup

### 1. Install

```bash
npm install
npm run build

# Install into OpenClaw (symlink for development):
openclaw hooks install --link /path/to/wodify-openclaw

# Or copy for production:
openclaw hooks install /path/to/wodify-openclaw
```

### 2. Discover Your Config

The discovery script automatically fetches all the Wodify-specific IDs you need. You only provide three things: your gym's subdomain, your email, and your password.

```bash
npx tsx discover.ts
```

The script will:
1. Resolve API version hashes from the live Wodify deployment (no hardcoded values)
2. Look up your account via email → discovers `customerHex`
3. Log in with a dummy customer ID → the server returns the real `customerId`
4. Fetch the gym's layout data → discovers `locationId` (and handles multi-location gyms)
5. Fetch tomorrow's class schedule, then check membership access → discovers `membershipId`

Example output:

```
wodify-openclaw config discovery
────────────────────────────────────────

0. Resolving API versions...
   moduleVersion: {moduleVersion}

1. Email lookup...
   customerHex = {customerHex}

2. Logging in...
   Logged in as {name} (customerId={customerId})

3. Fetching gym locations...
   {gymName} (locationId={locationId})

4. Fetching schedule for {date}...
   Found 8 classes. Using: [{classId}] CrossFit

5. Checking membership access...
   Memberships found:
     [{membershipId}] Unlimited CrossFit (unlimited)

────────────────────────────────────────────────────────────
RESULTS
────────────────────────────────────────────────────────────

.env:
WODIFY_GYM_SUBDOMAIN={gymSubdomain}
WODIFY_EMAIL={email}
WODIFY_PASSWORD={password}
WODIFY_CUSTOMER_HEX={customerHex}
WODIFY_CUSTOMER_ID={customerId}
WODIFY_LOCATION_ID={locationId}
WODIFY_MEMBERSHIP_ID={membershipId}

openclaw.json plugin config:
{ ... }
```

If `membershipId` can't be discovered (the `getClassAccess` endpoint occasionally returns empty due to an OutSystems quirk), the script will tell you. In that case, book a class in your browser with DevTools open and grab `inputParameters.SelectedMembershipId` from the booking POST request. This is the only value that might need a manual lookup.

### 3. Configure

Copy the output into a `.env` file (gitignored) in the plugin directory:

```bash
WODIFY_GYM_SUBDOMAIN={gymSubdomain}
WODIFY_EMAIL={email}
WODIFY_PASSWORD={password}
WODIFY_CUSTOMER_HEX={customerHex}
WODIFY_CUSTOMER_ID={customerId}
WODIFY_LOCATION_ID={locationId}
WODIFY_MEMBERSHIP_ID={membershipId}
```

Or pass config directly via `openclaw.json` (takes precedence over env vars):

```json
{
  "plugins": {
    "entries": {
      "wodify": {
        "path": "/path/to/wodify-openclaw",
        "config": {
          "gymSubdomain": "{gymSubdomain}",
          "email": "{email}",
          "password": "{password}",
          "customerHex": "{customerHex}",
          "customerId": "{customerId}",
          "locationId": "{locationId}",
          "membershipId": "{membershipId}"
        }
      }
    }
  }
}
```

### 4. Agent Config

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

### 5. Cron (Optional)

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

- `getClassAccess` endpoint occasionally returns empty — membership ID may need to be found manually (one-time)
- Waitlist joining is detected but not yet implemented
- Session re-auth on expiration is not yet handled
