#!/usr/bin/env npx tsx
/**
 * discover.ts — interactive config discovery for wodify-openclaw.
 *
 * Run with: npx tsx discover.ts
 *
 * Asks for your gym subdomain, email, and password, then automatically
 * discovers all config values needed for .env or openclaw.json.
 * All API version hashes are resolved dynamically from the live deployment.
 */
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';

// --- Prompt helpers ---

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let value = '';

    const onData = (char: string) => {
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (char === '\u0003') {
        process.exit();
      } else if (char === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };

    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
}

function promptWithDefault(question: string, defaultVal: string): Promise<string> {
  const display = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
  return prompt(display).then((v) => v || defaultVal);
}

// --- Version resolution ---

// Maps endpoint screenservices paths to the JS file that contains their apiVersion.
// The JS files use callDataAction/callServerAction("Name", "screenservices/...", "apiVersion", ...)
const ENDPOINT_SOURCES: Record<string, { script: string; pathFragment: string }> = {
  emailLookup: {
    script: 'OnlineSalesPage.Common.UserInfo.mvc',
    pathFragment: 'ServiceAPIGetSignInGlobalUserNameByEmail',
  },
  login: {
    script: 'OnlineSalesPage_CW.controller',
    pathFragment: 'ActionPrepare_LoginUser',
  },
  layoutTopInit: {
    script: 'OnlineSalesPage.Layouts.LayoutTop.mvc',
    pathFragment: 'DataActionGet_InitialData_InLayoutTop',
  },
  schedule: {
    script: 'OnlineSalesPage.Screens.Classes.mvc',
    pathFragment: 'DataActionGetClassSchedule_InClasses',
  },
  classAccess: {
    script: 'OnlineSalesPage_CW.Classes.MembershipType.mvc',
    pathFragment: 'DataActionGetClassAccess_InMembershipType',
  },
};

async function resolveVersions(
  base: string,
): Promise<{ moduleVersion: string; apiVersions: Record<string, string> }> {
  // 1. Get current moduleVersion
  const versionRes = await fetch(`${base}/OnlineSalesPage/moduleservices/moduleversioninfo`);
  const { versionToken } = (await versionRes.json()) as { versionToken: string };

  // 2. Get script URL map from moduleinfo
  const infoRes = await fetch(`${base}/OnlineSalesPage/moduleservices/moduleinfo`);
  const { manifest } = (await infoRes.json()) as {
    manifest: { urlVersions: Record<string, string> };
  };
  const urlVersions = manifest.urlVersions;

  // 3. For each endpoint, find its JS file and extract apiVersion
  const apiVersions: Record<string, string> = {};

  for (const [key, { script, pathFragment }] of Object.entries(ENDPOINT_SOURCES)) {
    // Find the script URL by matching the name
    const scriptPath = Object.keys(urlVersions).find(
      (k) => k.includes(script) && k.endsWith('.js'),
    );
    if (!scriptPath) {
      console.error(`   Warning: could not find script for ${key} (${script})`);
      continue;
    }

    const jsRes = await fetch(`${base}${scriptPath}`);
    const js = await jsRes.text();

    // Pattern: callDataAction("...", "screenservices/.../PathFragment", "apiVersion", ...)
    // or callServerAction with same pattern
    const escaped = pathFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = js.match(new RegExp(`${escaped}[^"]*",\\s*"([A-Za-z0-9+/=_-]{10,})"`));
    if (match) {
      apiVersions[key] = match[1];
    } else {
      console.error(`   Warning: could not extract apiVersion for ${key} from ${scriptPath}`);
    }
  }

  return { moduleVersion: versionToken, apiVersions };
}

// --- Wodify HTTP layer ---

const cookies = new Map<string, string>();
let csrfToken = 'bootstrap';
let baseUrl = '';

function cookieString(): string {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function extractCookies(res: Response): void {
  for (const header of res.headers.getSetCookie?.() ?? []) {
    const m = header.match(/^([^=]+)=([^;]*)/);
    if (m) cookies.set(m[1], m[2]);
  }
  const nr2 = cookies.get('nr2W_Theme_UI');
  if (nr2) {
    try {
      for (const part of decodeURIComponent(nr2).split(';')) {
        const [k, ...rest] = part.split('=');
        if (k.trim() === 'crf') {
          csrfToken = rest.join('=');
          break;
        }
      }
    } catch {}
  }
}

async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json',
      Origin: baseUrl,
      Referer: `${baseUrl}/OnlineSalesPage/Main`,
      'x-csrftoken': csrfToken,
      Cookie: cookieString(),
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  extractCookies(res);
  try {
    return (await res.json()) as T;
  } catch {
    return {} as T;
  }
}

const LOOKUP_PATH =
  '/OnlineSalesPage/screenservices/OnlineSalesPage/Common/UserInfo/ServiceAPIGetSignInGlobalUserNameByEmail';

async function bootstrapSession(): Promise<void> {
  cookies.set('osVisitor', randomUUID());
  cookies.set('osVisit', randomUUID());
  await post(LOOKUP_PATH, {
    versionInfo: { moduleVersion: 'bootstrap', apiVersion: 'bootstrap' },
    viewName: 'Main.Main',
    inputParameters: { Request: { Email: '' } },
  }).catch(() => {});
}

// --- Main ---

console.log('\nwodify-openclaw config discovery\n' + '─'.repeat(40));

const gymSubdomain = await promptWithDefault(
  'Gym subdomain (e.g. "delraybeach" from delraybeach.wodify.com)',
  process.env.WODIFY_GYM_SUBDOMAIN ?? '',
);
const email = await promptWithDefault('Email', process.env.WODIFY_EMAIL ?? '');
const password = await promptPassword(
  `Password${process.env.WODIFY_PASSWORD ? ' [from env]' : ''}: `,
);
const resolvedPassword = password || process.env.WODIFY_PASSWORD || '';

if (!gymSubdomain || !email || !resolvedPassword) {
  console.error('\nGym subdomain, email, and password are all required.');
  process.exit(1);
}

baseUrl = `https://${gymSubdomain}.wodify.com`;

// --- Resolve API versions from live deployment ---
console.log('\n0. Resolving API versions...');
const { moduleVersion, apiVersions } = await resolveVersions(baseUrl);
console.log(`   moduleVersion: ${moduleVersion}`);

function ver(key: string) {
  return { moduleVersion, apiVersion: apiVersions[key] ?? '' };
}

// --- Step 1: Bootstrap + email lookup → customerHex ---
console.log('\n1. Email lookup...');
await bootstrapSession();

const lookupRes: any = await post(LOOKUP_PATH, {
  versionInfo: ver('emailLookup'),
  viewName: 'Main.Main',
  inputParameters: { Request: { Email: email } },
});

if (lookupRes?.data?.Response?.Error?.HasError) {
  console.error(`   Failed: ${lookupRes.data.Response.Error.ErrorMessage}`);
  process.exit(1);
}

let customerHex: string = lookupRes?.data?.Response?.Customer ?? '';
if (!customerHex) {
  console.error('   Could not retrieve customerHex — check gym subdomain and email.');
  process.exit(1);
}
console.log(`   customerHex = ${customerHex}`);

// --- Step 2: Login with customerId="0" → real customerId ---
console.log('\n2. Logging in...');
const loginRes: any = await post(
  '/OnlineSalesPage/screenservices/OnlineSalesPage_CW/ActionPrepare_LoginUser',
  {
    versionInfo: ver('login'),
    viewName: 'Main.Main',
    inputParameters: {
      UserName: email,
      Password: resolvedPassword,
      ApplicationSourceId: 13,
      CustomerId: '0',
      SkipPasswordCheck: false,
      LoginToken: '',
    },
  },
);

if (loginRes?.data?.ErrorMessage) {
  console.error(`   Login failed: ${loginRes.data.ErrorMessage}`);
  process.exit(1);
}

const user = loginRes?.data?.Response_ValidateLogin;
const userId = user?.UserId ?? '';
const globalUserId = user?.GlobalUserId ?? '';
const customerId = user?.CustomerId ?? '';
customerHex = user?.Customer ?? customerHex;
console.log(`   Logged in as ${user?.GlobalUserFirstName} (customerId=${customerId})`);

// --- Step 3: LayoutTop initial data → locationId ---
console.log('\n3. Fetching gym locations...');

const clientVariables = {
  IsInMembershipsFlow: false,
  CustomerId: customerId,
  LocationId: 0,
  LoggedInGuardianId_Deprecated: '0',
  Customer: customerHex,
  PrefilledEmail: '',
  IsHeaderReady: true,
  IsWebIntegration: false,
};

const layoutRes: any = await post(
  '/OnlineSalesPage/screenservices/OnlineSalesPage/Layouts/LayoutTop/DataActionGet_InitialData_InLayoutTop',
  {
    versionInfo: ver('layoutTopInit'),
    viewName: 'Main.Main',
    screenData: { variables: {} },
    clientVariables,
  },
);

const locations: any[] = layoutRes?.data?.ActiveLocations?.List ?? [];
let locationId = 0;
let locationName = '';

if (locations.length === 0) {
  console.log('   No locations found.');
} else if (locations.length === 1) {
  locationId = locations[0].Id;
  locationName = locations[0].Name;
  console.log(`   ${locationName} (locationId=${locationId})`);
} else {
  console.log('   Multiple locations found:');
  for (let i = 0; i < locations.length; i++) {
    console.log(`     ${i + 1}. ${locations[i].Name} (${locations[i].Id})`);
  }
  const choice = await prompt(`   Select location [1-${locations.length}]: `);
  const idx = parseInt(choice, 10) - 1;
  if (idx >= 0 && idx < locations.length) {
    locationId = locations[idx].Id;
    locationName = locations[idx].Name;
  } else {
    locationId = locations[0].Id;
    locationName = locations[0].Name;
    console.log(`   Defaulting to: ${locationName}`);
  }
}

// --- Step 4: Schedule + getClassAccess → membershipId ---
let membershipId = '';

if (locationId) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = tomorrow.toISOString().split('T')[0];

  const cv = { ...clientVariables, LocationId: locationId };

  console.log(`\n4. Fetching schedule for ${date}...`);
  const schedRes: any = await post(
    '/OnlineSalesPage/screenservices/OnlineSalesPage/Screens/Classes/DataActionGetClassSchedule_InClasses',
    {
      versionInfo: ver('schedule'),
      viewName: 'Main.Main',
      screenData: {
        variables: {
          ProgramsList: { List: [] },
          SelectedProgramList: { List: [] },
          EmployeesList: { List: [] },
          SelectedEmployeesList: { List: [], EmptyListItem: { Id: '0' } },
          SelectedDate: date,
          SelectedDate_WeekChange: date,
          SelectedLocationId: locationId,
          LocationId: locationId,
        },
      },
      clientVariables: cv,
    },
  );

  const classes: any[] = schedRes?.data?.ClassSchedule?.List ?? [];
  if (classes.length === 0) {
    console.log('   No classes found for tomorrow — try again when classes are scheduled.');
  } else {
    const first = classes[0];
    const classId = String(first.Class.Id);
    const programId = first.Program.Id;
    console.log(`   Found ${classes.length} classes. Using: [${classId}] ${first.Class.Name}`);

    console.log('\n5. Checking membership access...');
    const accessRes: any = await post(
      '/OnlineSalesPage/screenservices/OnlineSalesPage_CW/Classes/MembershipType/DataActionGetClassAccess_InMembershipType',
      {
        versionInfo: ver('classAccess'),
        viewName: 'Main.Main',
        screenData: {
          variables: {
            LoggedIn_UserId: userId,
            LoggedIn_GlobalUserId: globalUserId,
            LoggedIn_Email: email,
            Customer: customerHex,
            LocationId: locationId,
            ClassId: classId,
            HasProgramAccess: true,
            SelectedMembershipId: '0',
            ReservationOpenDateTime: new Date().toISOString(),
            FilterProgramId: programId,
          },
        },
        clientVariables: cv,
      },
    );

    const memberships: any[] = accessRes?.data?.MembershipsAvailable?.List ?? [];
    if (memberships.length > 0) {
      membershipId = memberships[0].Id;
      console.log('   Memberships found:');
      for (const m of memberships) {
        console.log(`     [${m.Id}] ${m.Name}${m.IsUnlimited ? ' (unlimited)' : ''}`);
      }
    } else {
      console.log(
        '   getClassAccess returned no memberships (known OutSystems quirk).\n' +
          '   Fallback: book a class in browser DevTools → POST body → inputParameters.SelectedMembershipId',
      );
    }
  }
}

// --- Output ---
console.log('\n' + '─'.repeat(60));
console.log('RESULTS');
console.log('─'.repeat(60));

console.log('\n.env:');
console.log(`WODIFY_GYM_SUBDOMAIN=${gymSubdomain}`);
console.log(`WODIFY_EMAIL=${email}`);
console.log(`WODIFY_PASSWORD=${resolvedPassword}`);
console.log(`WODIFY_CUSTOMER_HEX=${customerHex}`);
console.log(`WODIFY_CUSTOMER_ID=${customerId}`);
if (locationId) {
  console.log(`WODIFY_LOCATION_ID=${locationId}`);
} else {
  console.log(`  # WODIFY_LOCATION_ID — not discovered`);
}
if (membershipId) {
  console.log(`WODIFY_MEMBERSHIP_ID=${membershipId}`);
} else {
  console.log(`  # WODIFY_MEMBERSHIP_ID — not discovered`);
}

console.log('\nopenclaw.json plugin config:');
console.log(
  JSON.stringify(
    {
      gymSubdomain,
      email,
      password: resolvedPassword,
      customerHex,
      customerId,
      locationId: locationId || '<not discovered>',
      membershipId: membershipId || '<not discovered>',
    },
    null,
    2,
  ),
);

console.log('');
