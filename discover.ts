#!/usr/bin/env npx tsx
/**
 * discover.ts — interactive config discovery for wodify-openclaw.
 *
 * Run with: npx tsx discover.ts
 *   → interactive: prompts for gym subdomain, email, password
 *   → outputs discovered config values to console
 *
 * Run with: npx tsx discover.ts --install
 *   → also writes config directly to ~/.openclaw/openclaw.json
 *   → first-time setup: run this once, never touch config again
 */
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const INSTALL_MODE = process.argv.includes('--install');

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

// Load existing openclaw.json config for defaults
function loadExistingWodifyConfig(): Record<string, unknown> {
  const configPath = join(process.env.HOME ?? '', '.openclaw', 'openclaw.json');
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    return (raw?.plugins?.entries?.wodify?.config as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

// --- Version resolution ---

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
  booking: {
    script: 'OnlineSalesPage_CW.Classes.MembershipType.mvc',
    pathFragment: 'ActionBookClassWithExistingMembership',
  },
  membershipInit: {
    script: 'OnlineSalesPage_CW.Classes.MembershipType.mvc',
    pathFragment: 'DataActionGet_InitialData_InMembershipType',
  },
  membershipClass: {
    script: 'OnlineSalesPage_CW.Classes.MembershipType.mvc',
    pathFragment: 'DataActionGet_Class_InMembershipType',
  },
  membershipPlans: {
    script: 'OnlineSalesPage_CW.Classes.MembershipType.mvc',
    pathFragment: 'DataActionGet_ClassPlansAndPacks_InMembershipType',
  },
};

async function resolveVersions(
  base: string,
): Promise<{ moduleVersion: string; apiVersions: Record<string, string> }> {
  const versionRes = await fetch(`${base}/OnlineSalesPage/moduleservices/moduleversioninfo`);
  const { versionToken } = (await versionRes.json()) as { versionToken: string };

  const infoRes = await fetch(`${base}/OnlineSalesPage/moduleservices/moduleinfo`);
  const { manifest } = (await infoRes.json()) as {
    manifest: { urlVersions: Record<string, string> };
  };
  const urlVersions = manifest.urlVersions;

  const apiVersions: Record<string, string> = {};
  for (const [key, { script, pathFragment }] of Object.entries(ENDPOINT_SOURCES)) {
    const scriptPath = Object.keys(urlVersions).find(
      (k) => k.includes(script) && k.endsWith('.js'),
    );
    if (!scriptPath) {
      console.error(`   Warning: could not find script for ${key} (${script})`);
      continue;
    }

    const jsRes = await fetch(`${base}${scriptPath}`);
    const js = await jsRes.text();

    const escaped = pathFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = js.match(new RegExp(`${escaped}[^"]*",\\s*"([A-Za-z0-9+=_-]{10,})"`));
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
if (INSTALL_MODE) {
  console.log('Mode: --install (will write to ~/.openclaw/openclaw.json)\n');
}

const existing = loadExistingWodifyConfig();

const gymSubdomainRaw = await promptWithDefault(
  'Gym subdomain (e.g. "delraybeach" from delraybeach.wodify.com)',
  (existing.gymSubdomain as string) ?? process.env.WODIFY_GYM_SUBDOMAIN ?? '',
);
const gymSubdomain = gymSubdomainRaw.replace(/\.wodify\.com.*$/i, '');
const email = await promptWithDefault(
  'Email',
  (existing.email as string) ?? process.env.WODIFY_EMAIL ?? '',
);
const password = await promptPassword(
  `Password${existing.password || process.env.WODIFY_PASSWORD ? ' [from config/env]' : ''}: `,
);
const resolvedPassword = password || (existing.password as string) || process.env.WODIFY_PASSWORD || '';

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

// --- Step 4 & 5: Schedule + two-step membership chain → membershipId ---
let membershipId = '';

if (locationId) {
  const cv = { ...clientVariables, LocationId: locationId };

  let classes: any[] = [];
  let date = '';
  console.log('\n4. Scanning upcoming schedule for classes...');
  for (let daysAhead = 1; daysAhead <= 7; daysAhead++) {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    date = d.toISOString().split('T')[0];
    const schedRes: any = await post(
      '/OnlineSalesPage/screenservices/OnlineSalesPage/Screens/Classes/DataActionGetClassSchedule_InClasses',
      {
        versionInfo: ver('schedule'),
        viewName: 'Main.Main',
        screenData: {
          variables: {
            ProgramsList: {
              List: [
                { Value: '119335', Label: '', IsSelect: true, ImageUrl: '' },
                { Value: '119416', Label: '', IsSelect: true, ImageUrl: '' },
                { Value: '134852', Label: '', IsSelect: true, ImageUrl: '' },
              ],
            },
            SelectedProgramList: { List: [{ Id: '119335' }, { Id: '119416' }, { Id: '134852' }] },
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
    classes = schedRes?.data?.ClassSchedule?.List ?? [];
    if (classes.length > 0) {
      console.log(`   Found ${classes.length} classes on ${date}.`);
      break;
    }
    console.log(`   No classes on ${date}, trying next day...`);
  }

  if (classes.length === 0) {
    console.log('   No classes found in the next 7 days — try again when classes are scheduled.');
  } else {
    const first = classes[0];
    const classId = String(first.Class.Id);
    const programId = first.Program.Id;
    console.log(`   Using: [${classId}] ${first.Class.Name} on ${date}`);

    const membershipCv = {
      PrefilledEmail: '',
      LoggedIn_GlobalUserId: globalUserId,
      LoggedIn_UserName: '',
      BookedForListSerialized: '',
      TokenForCreatePassword: '',
      LoggedIn_UserId: userId,
      LoggedIn_LeadId: '0',
      LoggedIn_CustomerId: customerId,
      OnlineMembershipSaleId: '0',
      LoggedIn_Email: email,
    };

    const baseScreenVars: any = {
      FilterProgramId: programId,
      LoggedIn_UserId: userId,
      LoggedIn_GlobalUserId: globalUserId,
      LoggedIn_Email: email,
      Customer: customerHex,
      LocationId: locationId,
      ClassId: classId,
      HasProgramAccess: true,
      SelectedMembershipId: '0',
      ReservationOpenDateTime: new Date().toISOString(),
      BookWithNewMembershipClicked: false,
      IsButtonLoading: false,
      CustomerCountNoShowReservations: false,
      ContractTerm: 'Contract',
      ShowBookingList: true,
      IsToViewPurchaseOnly: false,
    };

    console.log('\n5. Fetching class data for MembershipType screen...');
    const classInfoRes: any = await post(
      '/OnlineSalesPage/screenservices/OnlineSalesPage_CW/Classes/MembershipType/DataActionGet_Class_InMembershipType',
      {
        versionInfo: ver('membershipClass'),
        viewName: 'Main.Main',
        screenData: { variables: baseScreenVars },
        clientVariables: membershipCv,
      },
    );

    if (classInfoRes?.exception) {
      console.log(`   Get_Class error: ${classInfoRes.exception.message}`);
    } else {
      console.log(`   Get_Class OK (${first.Class.Name})`);

      const fullScreenVars = {
        ...baseScreenVars,
        Get_Class_InMembershipType: classInfoRes.data,
        _classIdInDataFetchStatus: 1,
        _locationIdInDataFetchStatus: 1,
        _customerInDataFetchStatus: 1,
        _showBookingListInDataFetchStatus: 1,
        _isToViewPurchaseOnlyInDataFetchStatus: 1,
        _hasProgramAccessInDataFetchStatus: 1,
      };

      console.log('   Fetching membership access...');
      const accessRes: any = await post(
        '/OnlineSalesPage/screenservices/OnlineSalesPage_CW/Classes/MembershipType/DataActionGetClassAccess_InMembershipType',
        {
          versionInfo: ver('classAccess'),
          viewName: 'Main.Main',
          screenData: { variables: fullScreenVars },
          clientVariables: membershipCv,
        },
      );

      if (accessRes?.exception) {
        console.log(`   GetClassAccess error: ${accessRes.exception.message}`);
        console.log('   Raw:', JSON.stringify(accessRes, null, 2));
      } else {
        const memberships = accessRes?.data?.MembershipsAvailable?.List ?? [];
        if (memberships.length > 0) {
          membershipId = memberships[0].Id;
          console.log('   Memberships found:');
          for (const m of memberships) {
            console.log(
              `     [${m.Id}] ${m.Name} (${m.AttendanceLimitationLabel})${m.IsAutoRenew ? ' [auto-renew]' : ''}`,
            );
          }
        } else {
          console.log(
            '   No memberships in response:',
            JSON.stringify(accessRes?.data, null, 2).slice(0, 500),
          );
        }
      }
    }
  }
}

// --- Output ---
console.log('\n' + '─'.repeat(60));
console.log('RESULTS');
console.log('─'.repeat(60));

const versionHashes = {
  moduleVersion,
  schedule: apiVersions.schedule ?? '',
  emailLookup: apiVersions.emailLookup ?? '',
  login: apiVersions.login ?? '',
  booking: apiVersions.booking ?? '',
  classAccess: apiVersions.classAccess ?? '',
  membershipInit: apiVersions.membershipInit ?? '',
  membershipClass: apiVersions.membershipClass ?? '',
  membershipPlans: apiVersions.membershipPlans ?? '',
};

const discoveredConfig = {
  gymSubdomain,
  email,
  password: resolvedPassword,
  customerHex,
  customerId,
  locationId: locationId || '<not discovered>',
  membershipId: membershipId || '<not discovered>',
  versionHashes,
};

console.log('\nopenclaw.json plugin config:');
console.log(JSON.stringify(discoveredConfig, null, 2));

// --- Write to ~/.openclaw/openclaw.json ---
const openclawConfigPath = join(process.env.HOME ?? '', '.openclaw', 'openclaw.json');

if (INSTALL_MODE) {
  // --install: write full config to openclaw.json
  try {
    let raw: any = {};
    if (existsSync(openclawConfigPath)) {
      raw = JSON.parse(readFileSync(openclawConfigPath, 'utf8'));
    }

    raw.plugins ??= {};
    raw.plugins.entries ??= {};
    raw.plugins.entries.wodify ??= {};
    raw.plugins.entries.wodify.config = discoveredConfig;

    writeFileSync(openclawConfigPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    console.log(`\nWritten to ${openclawConfigPath}`);
  } catch (e) {
    console.error(`\nFailed to write to ${openclawConfigPath}: ${e}`);
    console.log('Copy the config above manually.');
  }
} else {
  // Default mode: update only versionHashes + membershipId if openclaw.json exists
  try {
    if (existsSync(openclawConfigPath)) {
      const raw = JSON.parse(readFileSync(openclawConfigPath, 'utf8'));
      const wc = raw?.plugins?.entries?.wodify?.config;
      if (wc) {
        wc.versionHashes = versionHashes;
        if (membershipId) wc.membershipId = membershipId;
        writeFileSync(openclawConfigPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
        console.log(`\nUpdated versionHashes${membershipId ? ' + membershipId' : ''} in ${openclawConfigPath}`);
      }
    }
  } catch {
    // Silently skip if config isn't accessible
  }
  console.log('\nTip: run with --install to write full config to openclaw.json on first setup.');
}

console.log('');
