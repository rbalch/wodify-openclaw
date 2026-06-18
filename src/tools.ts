import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { Type } from '@sinclair/typebox';
import { WodifyClient, WodifyDriftError } from './wodify-client.js';
import { discoverConfig, discoverMembershipId, discoverVersionHashes } from './discover-client.js';
import type { WodifyPluginConfig, ClassScheduleItem, VersionHashes } from './types.js';

// Cron job ID for the wodify-booker agent (stable, set at creation time)
const CRON_JOB_ID = '1ca611cc-70d5-424b-874c-cd6fc3758956';

// Plugin config injected by OpenClaw register(), falls back to env vars
let pluginConfig: WodifyPluginConfig | null = null;

export function setPluginConfig(config: WodifyPluginConfig): void {
  pluginConfig = config;
  client = null; // reset client when config changes
}

// Client instance — fresh per tool invocation to avoid stale server-side sessions.
// Wodify's OutSystems auth is server-side (cookies stay anonymous-looking), so there's
// no way to detect expiry client-side. Cheapest fix: just re-login every time.
let client: WodifyClient | null = null;

function getClient(config: WodifyPluginConfig): WodifyClient {
  client = new WodifyClient(config);
  return client;
}

function resolveConfig(): WodifyPluginConfig {
  return pluginConfig ?? getConfigFromEnv();
}

/**
 * Write updates to ~/.openclaw/openclaw.json under plugins.entries.wodify.config.
 * Silently no-ops if the file isn't accessible (env-var mode or file missing).
 */
function updateOpenClawConfig(updates: Partial<WodifyPluginConfig>): void {
  const configPath = join(process.env.HOME ?? '', '.openclaw', 'openclaw.json');
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    Object.assign(raw.plugins.entries.wodify.config, updates);
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  } catch {
    // Config file not accessible — in-memory update only
  }
}

/** Apply a config update both to the file and the in-memory pluginConfig. Resets client. */
function applyConfigUpdate(updates: Partial<WodifyPluginConfig>): void {
  updateOpenClawConfig(updates);
  if (pluginConfig) {
    Object.assign(pluginConfig, updates);
  }
  client = null; // force fresh client with updated config
}

function isMembershipError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('do not have an active membership');
}

function isDriftError(err: unknown): err is WodifyDriftError {
  return err instanceof WodifyDriftError;
}

/**
 * Recover from a Wodify version drift by re-discovering hashes (and membershipId, since
 * a deploy can rotate everything). Persists fresh values to openclaw.json.
 * Returns the updated config so the caller can retry the failed call.
 */
async function recoverFromDrift(config: WodifyPluginConfig): Promise<WodifyPluginConfig> {
  const { versionHashes, membershipId } = await discoverConfig(config);
  const updates: Partial<WodifyPluginConfig> = { versionHashes };
  if (membershipId && membershipId !== config.membershipId) {
    updates.membershipId = membershipId;
  }
  applyConfigUpdate(updates);
  return { ...config, ...updates };
}

function formatClass(item: ClassScheduleItem): string {
  const c = item.Class;
  const coaches = c.Coaches.List.map((coach) => coach.CoachName).join(', ') || 'TBD';
  const time = c.StartTime.slice(0, 5);
  const endTime = c.EndDateTime.split('T')[1]?.slice(0, 5) ?? '';
  const status = c.IsCancelled
    ? 'CANCELLED'
    : c.IsFull
      ? 'FULL'
      : c.Available > 0
        ? `${c.Available} spots`
        : 'Open';

  return [
    `[${c.Id}] ${c.Name}`,
    `  Time: ${time}–${endTime}`,
    `  Coach: ${coaches}`,
    `  Status: ${status}`,
    `  Program: ${item.Program.Name || item.Class.GymProgramId}`,
    c.Description ? `  Note: ${c.Description}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function doBooking(
  config: WodifyPluginConfig,
  params: { class_id: string; program_id?: string },
) {
  const c = getClient(config);
  const programId = params.program_id || '119335';
  const result = await c.bookClassBySchedule(params.class_id, programId);
  return {
    content: [
      {
        type: 'text' as const,
        text: result.success
          ? `Booked class ${params.class_id}! ${result.message}`
          : `Booking failed for class ${params.class_id}: ${result.message}`,
      },
    ],
    details: result,
  };
}

// --- Tool: get_classes ---

export const getClassesTool = {
  name: 'wodify_get_classes',
  label: 'Wodify Get Classes',
  description:
    'Fetch the class schedule from Wodify for a given date. Returns available CrossFit, Open Gym, and other classes with times, coaches, and availability. No authentication required.',
  parameters: Type.Object({
    date: Type.String({
      description: 'Date to fetch classes for (YYYY-MM-DD). Defaults to tomorrow.',
    }),
    program_filter: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Program IDs to filter by. Defaults to all (CrossFit=119335, Open Gym=119416, Off Hours=134852).',
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { date?: string; program_filter?: string[] },
    _signal?: AbortSignal,
  ) {
    let config = resolveConfig();
    const date = params.date || getTomorrowDate();

    async function fetch(cfg: WodifyPluginConfig): Promise<ClassScheduleItem[]> {
      return getClient(cfg).getClasses(date, params.program_filter);
    }

    let classes: ClassScheduleItem[];
    try {
      classes = await fetch(config);
    } catch (err) {
      if (isDriftError(err)) {
        try {
          config = await recoverFromDrift(config);
          classes = await fetch(config);
        } catch (retryErr) {
          const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          return {
            content: [{ type: 'text' as const, text: `⚠️ Failed to fetch classes for ${date}: drift recovery failed: ${msg}\n\nYou MUST report this failure to the user.` }],
          };
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        const c = getClient(config);
        const drift = c.hasVersionDrift ? '\n(Note: Wodify version drift detected — hashes may need refresh via wodify_refresh_config)' : '';
        return {
          content: [{ type: 'text' as const, text: `⚠️ Failed to fetch classes for ${date}: ${msg}${drift}\n\nYou MUST report this failure to the user.` }],
        };
      }
    }

    if (classes.length === 0) {
      return {
        content: [{ type: 'text' as const, text: `No classes found for ${date}.` }],
        details: { date, count: 0, classes: [] },
      };
    }

    // Filter out cancelled classes for display
    const active = classes.filter((c) => !c.Class.IsCancelled);
    const formatted = active.map(formatClass).join('\n\n');
    const summary = `Found ${active.length} class${active.length === 1 ? '' : 'es'} on ${date}:\n\n${formatted}`;

    return {
      content: [{ type: 'text' as const, text: summary }],
      details: { date, count: active.length, classes: active },
    };
  },
};

// --- Tool: book_class ---

export const bookClassTool = {
  name: 'wodify_book_class',
  label: 'Wodify Book Class',
  description:
    'Book a specific class on Wodify. Requires the class ID (from get_classes) and the program ID. Handles login, membership lookup, and booking in one step. Self-heals stale membershipId automatically.',
  parameters: Type.Object({
    class_id: Type.String({
      description: 'The class ID to book (from the schedule results, e.g., "177315537").',
    }),
    program_id: Type.Optional(
      Type.String({
        description: 'The program ID for the class (e.g., "119335" for CrossFit). Defaults to CrossFit.',
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { class_id: string; program_id?: string },
    _signal?: AbortSignal,
  ) {
    let config = resolveConfig();

    let lastErr: unknown;
    try {
      return await doBooking(config, params);
    } catch (err) {
      lastErr = err;
    }

    // --- Self-heal: Wodify deployed, version hashes are stale ---
    if (isDriftError(lastErr)) {
      try {
        config = await recoverFromDrift(config);
      } catch (recoverErr) {
        const msg = recoverErr instanceof Error ? recoverErr.message : String(recoverErr);
        return {
          content: [
            {
              type: 'text' as const,
              text: `⚠️ Wodify version drift detected and auto-recovery failed: ${msg}\n\nYou MUST report this failure to the user.`,
            },
          ],
        };
      }
      try {
        return await doBooking(config, params);
      } catch (retryErr) {
        // Drift recovered but booking still failed — fall through to regular error reporting
        lastErr = retryErr;
      }
    }

    {
      const err = lastErr;
      // --- Self-heal: membership ID rotated ---
      if (isMembershipError(err)) {
        const newId = await discoverMembershipId(config).catch(() => '');

        if (!newId) {
          // Membership genuinely expired or account issue — disable cron and notify
          try {
            execSync(`openclaw cron disable ${CRON_JOB_ID}`);
          } catch {
            // Best-effort — cron disable failing shouldn't prevent the error message
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: '⚠️ Wodify booking failed: membership may have expired. Could not auto-recover a new membership ID. The booking cron has been disabled. Check your Wodify account and re-run `npx tsx discover.ts --install` when resolved.\n\nYou MUST report this failure to the user.',
              },
            ],
          };
        }

        config = { ...config, membershipId: newId };
        applyConfigUpdate({ membershipId: newId });
        try {
          return await doBooking(config, params);
        } catch (retryErr) {
          const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          return {
            content: [{ type: 'text' as const, text: `⚠️ Wodify booking failed after membership refresh: ${msg}\n\nYou MUST report this failure to the user.` }],
          };
        }
      }

      // Any other error — return it as a message, don't throw
      const msg = err instanceof Error ? err.message : String(err);
      const c = getClient(config);
      const drift = c.hasVersionDrift ? '\n(Note: Wodify version drift detected — hashes may need refresh via wodify_refresh_config)' : '';
      return {
        content: [{ type: 'text' as const, text: `⚠️ Wodify booking failed: ${msg}${drift}\n\nYou MUST report this failure to the user.` }],
      };
    }
  },
};

// --- Tool: check_access ---

export const checkAccessTool = {
  name: 'wodify_check_access',
  label: 'Wodify Check Access',
  description:
    'Check if you can reserve a specific class and list available memberships. Useful for debugging booking issues.',
  parameters: Type.Object({
    class_id: Type.String({ description: 'The class ID to check access for.' }),
    program_id: Type.Optional(
      Type.String({ description: 'Program ID. Defaults to CrossFit (119335).' }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { class_id: string; program_id?: string },
    _signal?: AbortSignal,
  ) {
    const config = resolveConfig();
    const c = getClient(config);

    const programId = params.program_id || '119335';
    const access = await c.getClassAccess(params.class_id, programId);

    const memberships = access.MembershipsAvailable.List.map(
      (m) => `  - ${m.Name} (${m.Id}) — ${m.AttendanceLimitationLabel}`,
    ).join('\n');

    const lines = [
      `Class ${params.class_id} access:`,
      `  Can reserve: ${access.ClassAccess.CanReserve}`,
      `  Can join waitlist: ${access.ClassAccess.CanJoinWaitlist}`,
      `  Blocked: ${access.ClassAccess.IsBlocked}${access.ClassAccess.BlockedText ? ` (${access.ClassAccess.BlockedText})` : ''}`,
      `  Already signed in: ${access.ClassAccess.HasSignedIn}`,
      `  Can cancel: ${access.ClassAccess.CanCancelReservation}`,
      '',
      `Memberships (${access.MembershipsAvailable.List.length}):`,
      memberships || '  (none)',
    ];

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      details: access,
    };
  },
};

// --- Tool: refresh_config ---

export const refreshConfigTool = {
  name: 'wodify_refresh_config',
  label: 'Wodify Refresh Config',
  description:
    'Proactively refresh Wodify config (version hashes + membership ID) from live Wodify data. Run on the 1st of the month to stay ahead of monthly membership rotation.',
  parameters: Type.Object({}),
  async execute(_toolCallId: string, _params: Record<never, never>, _signal?: AbortSignal) {
    const config = resolveConfig();
    const changes: string[] = [];

    // Refresh version hashes first (passing existing for WAF-walled endpoint fallback)
    let freshHashes: VersionHashes;
    try {
      freshHashes = await discoverVersionHashes(config.gymSubdomain, config.versionHashes);
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to refresh version hashes: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }

    if (!config.versionHashes || config.versionHashes.moduleVersion !== freshHashes.moduleVersion) {
      applyConfigUpdate({ versionHashes: freshHashes });
      changes.push(`versionHashes updated → moduleVersion: ${freshHashes.moduleVersion}`);
    }

    // Refresh membership ID using fresh hashes
    const configWithHashes = { ...config, versionHashes: freshHashes };
    let newMembershipId: string;
    try {
      newMembershipId = await discoverMembershipId(configWithHashes);
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `${changes.length ? changes.join('\n') + '\n' : ''}Failed to refresh membershipId: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }

    if (newMembershipId && newMembershipId !== config.membershipId) {
      applyConfigUpdate({ membershipId: newMembershipId });
      changes.push(`membershipId: ${config.membershipId} → ${newMembershipId}`);
    }

    const summary =
      changes.length > 0 ? `Config refreshed:\n${changes.join('\n')}` : 'Config is current — no changes needed.';

    return {
      content: [{ type: 'text' as const, text: summary }],
    };
  },
};

// --- Helpers ---

function getTomorrowDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

function getConfigFromEnv(): WodifyPluginConfig {
  const gymSubdomain = process.env.WODIFY_GYM_SUBDOMAIN;
  const email = process.env.WODIFY_EMAIL;
  const password = process.env.WODIFY_PASSWORD;
  const customerId = process.env.WODIFY_CUSTOMER_ID;
  const locationId = process.env.WODIFY_LOCATION_ID;
  const customerHex = process.env.WODIFY_CUSTOMER_HEX;
  const membershipId = process.env.WODIFY_MEMBERSHIP_ID;

  if (!gymSubdomain || !email || !password || !customerId || !locationId || !customerHex || !membershipId) {
    throw new Error(
      'Missing Wodify config. Required env vars: WODIFY_GYM_SUBDOMAIN, WODIFY_EMAIL, WODIFY_PASSWORD, WODIFY_CUSTOMER_ID, WODIFY_LOCATION_ID, WODIFY_CUSTOMER_HEX, WODIFY_MEMBERSHIP_ID',
    );
  }

  return {
    gymSubdomain,
    email,
    password,
    customerId,
    locationId: parseInt(locationId, 10),
    customerHex,
    membershipId,
  };
}
