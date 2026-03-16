import { Type } from '@sinclair/typebox';
import { WodifyClient } from './wodify-client.js';
import type { WodifyPluginConfig, ClassScheduleItem } from './types.js';

// Shared client instance — re-created if config changes
let client: WodifyClient | null = null;

function getClient(config: WodifyPluginConfig): WodifyClient {
  if (!client) {
    client = new WodifyClient(config);
  }
  return client;
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
    const config = getConfigFromEnv();
    const client = getClient(config);

    const date = params.date || getTomorrowDate();
    const classes = await client.getClasses(date, params.program_filter);

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
    'Book a specific class on Wodify. Requires the class ID (from get_classes) and the program ID. Handles login, membership lookup, and booking in one step.',
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
    const config = getConfigFromEnv();
    const client = getClient(config);

    const programId = params.program_id || '119335';
    const result = await client.bookClassBySchedule(params.class_id, programId);

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
    const config = getConfigFromEnv();
    const client = getClient(config);

    const programId = params.program_id || '119335';
    const access = await client.getClassAccess(params.class_id, programId);

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
