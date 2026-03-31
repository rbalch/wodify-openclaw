/**
 * discover-client.ts — non-interactive config discovery functions.
 *
 * Used by:
 *  - self-healing in bookClassTool (membership rotation, version hash staleness)
 *  - wodify_refresh_config tool (proactive monthly refresh)
 *  - discover.ts CLI (thin interactive wrapper)
 */
import { WodifyClient } from './wodify-client.js';
import type { MembershipInfo, VersionHashes, WodifyPluginConfig } from './types.js';

// Maps each versionHash key to the JS file + path fragment used to extract it.
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

/**
 * Discover current OutSystems deployment version hashes.
 * Two unauthenticated GETs — no session needed.
 */
export async function discoverVersionHashes(gymSubdomain: string): Promise<VersionHashes> {
  const base = `https://${gymSubdomain}.wodify.com`;

  const versionRes = await fetch(`${base}/OnlineSalesPage/moduleservices/moduleversioninfo`);
  if (!versionRes.ok) {
    throw new Error(`Failed to fetch moduleversioninfo: ${versionRes.status}`);
  }
  const { versionToken } = (await versionRes.json()) as { versionToken: string };

  const infoRes = await fetch(`${base}/OnlineSalesPage/moduleservices/moduleinfo`);
  if (!infoRes.ok) {
    throw new Error(`Failed to fetch moduleinfo: ${infoRes.status}`);
  }
  const { manifest } = (await infoRes.json()) as {
    manifest: { urlVersions: Record<string, string> };
  };
  const urlVersions = manifest.urlVersions;

  const apiVersions: Record<string, string> = {};
  for (const [key, { script, pathFragment }] of Object.entries(ENDPOINT_SOURCES)) {
    if (key === 'layoutTopInit') continue; // not needed in plugin config

    const scriptPath = Object.keys(urlVersions).find(
      (k) => k.includes(script) && k.endsWith('.js'),
    );
    if (!scriptPath) continue;

    const jsRes = await fetch(`${base}${scriptPath}`);
    const js = await jsRes.text();

    const escaped = pathFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = js.match(new RegExp(`${escaped}[^"]*",\\s*"([A-Za-z0-9+=_-]{10,})"`));
    if (match) {
      apiVersions[key] = match[1];
    }
  }

  return {
    moduleVersion: versionToken,
    schedule: apiVersions.schedule ?? '',
    emailLookup: apiVersions.emailLookup ?? '',
    login: apiVersions.login ?? '',
    booking: apiVersions.booking ?? '',
    classAccess: apiVersions.classAccess ?? '',
    membershipInit: apiVersions.membershipInit ?? '',
    membershipClass: apiVersions.membershipClass ?? '',
    membershipPlans: apiVersions.membershipPlans ?? '',
  };
}

/**
 * Discover the active membershipId for the configured account.
 *
 * Flow:
 *  1. Discover fresh version hashes (ensures we can call MembershipType endpoints)
 *  2. Login with a fresh WodifyClient using those hashes
 *  3. Scan up to 7 days ahead to find a class
 *  4. Run the two-step chain: Get_Class → GetClassAccess → MembershipsAvailable.List[0].Id
 *
 * Returns '' if no membership found (expired / account issue).
 */
export async function discoverMembershipId(config: WodifyPluginConfig): Promise<string> {
  // Always use fresh hashes so membership discovery never fails on stale versions
  const freshHashes = await discoverVersionHashes(config.gymSubdomain);
  const configWithHashes: WodifyPluginConfig = { ...config, versionHashes: freshHashes };
  const client = new WodifyClient(configWithHashes);

  await client.login();

  // Scan up to 7 days ahead for a day with classes
  let classId: string | null = null;
  let programId: string | null = null;

  for (let daysAhead = 1; daysAhead <= 7; daysAhead++) {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    const date = d.toISOString().split('T')[0];
    const classes = await client.getClasses(date);
    if (classes.length > 0) {
      classId = String(classes[0].Class.Id);
      programId = classes[0].Program.Id;
      break;
    }
  }

  if (!classId || !programId) {
    return ''; // No classes in the next 7 days — can't discover membership
  }

  let memberships: MembershipInfo[];
  try {
    memberships = await client.getClassMemberships(classId, programId);
  } catch {
    return '';
  }

  return memberships[0]?.Id ?? '';
}

export interface DiscoverResult {
  membershipId: string;
  versionHashes: VersionHashes;
}

/**
 * Full config discovery — version hashes + membership ID.
 * Used by wodify_refresh_config and first-time onboarding.
 */
export async function discoverConfig(config: WodifyPluginConfig): Promise<DiscoverResult> {
  const versionHashes = await discoverVersionHashes(config.gymSubdomain);
  const configWithHashes: WodifyPluginConfig = { ...config, versionHashes };
  const membershipId = await discoverMembershipId(configWithHashes);

  return { membershipId, versionHashes };
}
