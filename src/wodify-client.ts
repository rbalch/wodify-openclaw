import { randomUUID } from 'crypto';
import type {
  BookClassResponse,
  ClassAccessResponse,
  ClassScheduleItem,
  ClassScheduleResponse,
  EmailLookupResponse,
  LoginResponse,
  MembershipInfo,
  VersionHashes,
  WodifyClientVariables,
  WodifyPluginConfig,
  WodifySession,
} from './types.js';

/**
 * Thrown when Wodify's response shape is malformed in a way that indicates the
 * cached version hashes (moduleVersion / per-endpoint apiVersion) are stale.
 * Caller should refresh hashes via discoverConfig() and retry.
 */
export class WodifyDriftError extends Error {
  readonly hint: string;
  readonly endpoint: string;
  constructor(endpoint: string, hint: string) {
    super(`Wodify version drift on ${endpoint}: ${hint}`);
    this.name = 'WodifyDriftError';
    this.endpoint = endpoint;
    this.hint = hint;
  }
}

/** Reads `.Error` defensively. Throws WodifyDriftError if the field is missing. */
function readError(
  body: { Error?: { HasError?: boolean; ErrorMessage?: string } } | undefined,
  endpoint: string,
): { HasError: boolean; ErrorMessage?: string } {
  if (!body || !body.Error || typeof body.Error.HasError !== 'boolean') {
    throw new WodifyDriftError(
      endpoint,
      'response is missing the `Error` envelope — version hashes are likely stale',
    );
  }
  return body.Error as { HasError: boolean; ErrorMessage?: string };
}

// Hardcoded fallback hashes — used when versionHashes is not in plugin config.
// These go stale on every Wodify deploy; run discover.ts --install to update.
const VERSION_INFO = {
  schedule: { moduleVersion: '1BuJVGkuIdK2rrmcNZN5mA', apiVersion: 'Z++9XwHvg5pOrhQ+_6KNtg' },
  emailLookup: { moduleVersion: '1BuJVGkuIdK2rrmcNZN5mA', apiVersion: 'm0MMhE78rlyNJazWXLZpKg' },
  login: { moduleVersion: '1BuJVGkuIdK2rrmcNZN5mA', apiVersion: 'ZGa26PTySxkv1DvmjxEn_w' },
  booking: { moduleVersion: '1BuJVGkuIdK2rrmcNZN5mA', apiVersion: 'owTw8hgF2OfByCflv9dUZQ' },
  classAccess: { moduleVersion: '1BuJVGkuIdK2rrmcNZN5mA', apiVersion: '1XPPu_ntXIVRvoWOsmkwLQ' },
} as const;

const VIEW_NAME = 'Main.Main';
const APPLICATION_SOURCE_ID = 13;

export class WodifyClient {
  private baseUrl: string;
  private config: WodifyPluginConfig;
  private session: WodifySession;

  constructor(config: WodifyPluginConfig) {
    this.config = config;
    this.baseUrl = `https://${config.gymSubdomain}.wodify.com`;
    this.session = {
      cookies: new Map(),
      csrfToken: '',
      userId: '',
      globalUserId: '',
      customer: '',
      customerId: config.customerId,
      authenticated: false,
    };
  }

  get isAuthenticated(): boolean {
    return this.session.authenticated;
  }

  /** True if any response signaled a Wodify deployment changed version hashes. */
  get hasVersionDrift(): boolean {
    return this.versionDrifted;
  }

  private versionDrifted = false;
  private sessionInitialized = false;

  /**
   * Returns the versionInfo for an endpoint, preferring config hashes over the hardcoded fallback.
   */
  private getVI(key: keyof typeof VERSION_INFO): { moduleVersion: string; apiVersion: string } {
    const hashes = this.config.versionHashes;
    if (hashes) {
      return { moduleVersion: hashes.moduleVersion, apiVersion: hashes[key] };
    }
    return VERSION_INFO[key];
  }

  /**
   * Returns hashes for MembershipType-screen endpoints (not in VERSION_INFO fallback).
   * Requires versionHashes in config — throws if missing.
   */
  private getMembershipVI(key: 'membershipClass' | 'membershipInit' | 'membershipPlans'): {
    moduleVersion: string;
    apiVersion: string;
  } {
    const hashes = this.config.versionHashes;
    if (!hashes) {
      throw new Error(`${key} hash not in config — run discover.ts --install first`);
    }
    return { moduleVersion: hashes.moduleVersion, apiVersion: hashes[key] };
  }

  /**
   * Bootstrap an OutSystems session. The main page returns zero cookies,
   * so we generate osVisitor/osVisit UUIDs and make a throwaway POST to
   * a screenservices endpoint. The server responds with Set-Cookie headers
   * containing nr1W_Theme_UI and nr2W_Theme_UI (which carries the CSRF token).
   */
  async initSession(): Promise<void> {
    if (this.sessionInitialized) return;

    this.session.cookies.set('osVisitor', randomUUID());
    this.session.cookies.set('osVisit', randomUUID());

    // Throwaway POST — the 403 response sets the CSRF cookies
    const url = `${this.baseUrl}/OnlineSalesPage/screenservices/OnlineSalesPage/Common/UserInfo/ServiceAPIGetSignInGlobalUserNameByEmail`;
    let lastError: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            Accept: 'application/json',
            Origin: this.baseUrl,
            Referer: `${this.baseUrl}/OnlineSalesPage/Main`,
            'x-csrftoken': 'bootstrap',
            Cookie: this.getCookieString(),
          },
          body: JSON.stringify({
            versionInfo: this.getVI('emailLookup'),
            viewName: VIEW_NAME,
            inputParameters: { Request: { Email: '' } },
          }),
        });

        this.extractCookies(res);
        await res.text().catch(() => {}); // consume body

        this.sessionInitialized = true;
        return;
      } catch (err) {
        lastError = err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  // --- HTTP Layer ---

  private async request<T>(path: string, body: unknown, retries = 2): Promise<T> {
    await this.initSession();
    const url = `${this.baseUrl}${path}`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            Accept: 'application/json',
            Origin: this.baseUrl,
            Referer: `${this.baseUrl}/OnlineSalesPage/Main`,
            'x-csrftoken': this.session.csrfToken,
            Cookie: this.getCookieString(),
          },
          body: JSON.stringify(body),
          redirect: 'manual',
        });

        this.extractCookies(res);

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Wodify API error ${res.status}: ${text.slice(0, 200)}`);
        }

        const data = (await res.json()) as T;

        // Log version drift — data is still valid, just note it for future hash refresh
        const vi = (data as Record<string, unknown>)?.versionInfo as
          | { hasModuleVersionChanged?: boolean; hasApiVersionChanged?: boolean }
          | undefined;
        if (vi?.hasModuleVersionChanged || vi?.hasApiVersionChanged) {
          this.versionDrifted = true;
          console.warn(`[wodify] version drift detected (module=${vi.hasModuleVersionChanged}, api=${vi.hasApiVersionChanged})`);
        }

        return data;
      } catch (err) {
        // Only retry network-level failures (fetch failed, DNS, TLS, timeout)
        if (err instanceof Error && err.message.startsWith('Wodify API error')) {
          throw err;
        }
        lastError = err;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  private getCookieString(): string {
    return [...this.session.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private extractCookies(res: Response): void {
    for (const header of res.headers.getSetCookie?.() ?? []) {
      const match = header.match(/^([^=]+)=([^;]*)/);
      if (match) {
        this.session.cookies.set(match[1], match[2]);
      }
    }

    // Extract CSRF token from nr2W_Theme_UI cookie.
    // Format: crf=<token>;uid=0;unm= (semicolon-separated key=value pairs, URL-encoded)
    const nr2 = this.session.cookies.get('nr2W_Theme_UI');
    if (nr2) {
      try {
        const decoded = decodeURIComponent(nr2);
        for (const part of decoded.split(';')) {
          const [key, ...rest] = part.split('=');
          if (key.trim() === 'crf') {
            this.session.csrfToken = rest.join('=');
            break;
          }
        }
      } catch {
        // Malformed cookie — ignore
      }
    }
  }

  /**
   * OutSystems clientVariables — sent with every screenData-based request on the Classes screen.
   * Without this, screenData endpoints crash with NullReferenceException.
   */
  private getClientVariables(): WodifyClientVariables {
    return {
      IsInMembershipsFlow: false,
      CustomerId: this.config.customerId,
      LocationId: this.config.locationId,
      LoggedInGuardianId_Deprecated: '0',
      Customer: this.session.customer || this.config.customerHex,
      PrefilledEmail: '',
      IsHeaderReady: true,
      IsWebIntegration: false,
    };
  }

  /**
   * clientVariables for the MembershipType screen (OnlineSalesPage_CW module).
   * Completely different schema from the Classes screen — wrong schema → NullRef.
   */
  private getMembershipClientVariables(): Record<string, string> {
    return {
      PrefilledEmail: '',
      LoggedIn_GlobalUserId: this.session.globalUserId,
      LoggedIn_UserName: '',
      BookedForListSerialized: '',
      TokenForCreatePassword: '',
      LoggedIn_UserId: this.session.userId,
      LoggedIn_LeadId: '0',
      LoggedIn_CustomerId: this.config.customerId,
      OnlineMembershipSaleId: '0',
      LoggedIn_Email: this.config.email,
    };
  }

  // --- Auth ---

  async login(): Promise<{ userId: string; customer: string; firstName: string }> {
    // Step 1: Email lookup — also resolves Customer hex from email
    const lookupPath =
      '/OnlineSalesPage/screenservices/OnlineSalesPage/Common/UserInfo/ServiceAPIGetSignInGlobalUserNameByEmail';
    const lookupRes = await this.request<EmailLookupResponse>(lookupPath, {
      versionInfo: this.getVI('emailLookup'),
      viewName: VIEW_NAME,
      inputParameters: {
        Request: { Email: this.config.email },
      },
    });

    // Wodify wrapped the lookup payload in `ResponseGetSignInGlobalUserNameByEmail` post-2026-05
    // deploy; older deployments returned the fields directly under `Response`. Tolerate both.
    const lookupResponse = lookupRes.data?.Response as
      | (Record<string, unknown> & {
          Customer?: string;
          ResponseGetSignInGlobalUserNameByEmail?: { Customer?: string };
          Error?: { HasError?: boolean; ErrorMessage?: string };
        })
      | undefined;
    const lookupPayload =
      lookupResponse?.ResponseGetSignInGlobalUserNameByEmail ?? lookupResponse;
    const lookupErr = readError(lookupResponse, 'emailLookup');
    if (lookupErr.HasError) {
      throw new Error(`Email lookup failed: ${lookupErr.ErrorMessage}`);
    }
    if (!lookupPayload?.Customer) {
      throw new WodifyDriftError('emailLookup', 'response missing Customer field');
    }

    // Store Customer hex from lookup (needed for clientVariables before login completes)
    this.session.customer = lookupPayload.Customer;

    // Step 2: Password authentication
    const loginPath = '/OnlineSalesPage/screenservices/OnlineSalesPage_CW/ActionPrepare_LoginUser';
    const loginRes = await this.request<LoginResponse>(loginPath, {
      versionInfo: this.getVI('login'),
      viewName: VIEW_NAME,
      inputParameters: {
        UserName: this.config.email,
        Password: this.config.password,
        ApplicationSourceId: APPLICATION_SOURCE_ID,
        CustomerId: this.config.customerId,
        SkipPasswordCheck: false,
        LoginToken: '',
      },
    });

    if (loginRes.data.ErrorMessage) {
      throw new Error(`Login failed: ${loginRes.data.ErrorMessage}`);
    }

    const user = loginRes.data.Response_ValidateLogin;
    if (user.ClientIsSuspended || user.CustomerIsSuspended) {
      throw new Error('Account or gym is suspended');
    }
    if (!user.GlobalUserStatusId_IsActive) {
      throw new Error('Account is not active');
    }

    this.session.userId = user.UserId;
    this.session.globalUserId = user.GlobalUserId;
    this.session.customer = user.Customer;
    this.session.customerId = user.CustomerId;
    this.session.authenticated = true;

    console.log(`[wodify] login OK: userId=${user.UserId} globalUserId=${user.GlobalUserId} customer=${user.Customer}`);

    return {
      userId: user.UserId,
      customer: user.Customer,
      firstName: user.GlobalUserFirstName,
    };
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.session.authenticated) {
      await this.login();
    }
  }

  // --- Schedule ---

  async getClasses(date: string, programIds?: string[]): Promise<ClassScheduleItem[]> {
    const ids = programIds ?? ['119335', '119416', '134852'];
    const programsList = ids.map((id) => ({
      Value: id,
      Label: '',
      IsSelect: true,
      ImageUrl: '',
    }));
    const selectedProgramList = ids.map((id) => ({ Id: id }));

    const path =
      '/OnlineSalesPage/screenservices/OnlineSalesPage/Screens/Classes/DataActionGetClassSchedule_InClasses';
    const res = await this.request<ClassScheduleResponse>(path, {
      versionInfo: this.getVI('schedule'),
      viewName: VIEW_NAME,
      screenData: {
        variables: {
          ProgramsList: { List: programsList },
          SelectedProgramList: { List: selectedProgramList },
          EmployeesList: { List: [] },
          SelectedEmployeesList: { List: [], EmptyListItem: { Id: '0' } },
          SelectedDate: date,
          SelectedDate_WeekChange: date,
          SelectedLocationId: this.config.locationId,
          LocationId: this.config.locationId,
        },
      },
      clientVariables: this.getClientVariables(),
    });

    if (!res.data?.ClassSchedule?.List) {
      throw new WodifyDriftError('schedule', 'response is missing ClassSchedule.List');
    }
    const list = res.data.ClassSchedule.List;
    // An empty schedule while version drift is flagged is suspicious: Wodify deploys can
    // transiently return an empty list inside a valid envelope (HTTP 200, no error). Treat it
    // as drift so the tool layer re-discovers hashes and retries once, rather than silently
    // reporting "No classes found" and giving up. If the day is genuinely empty, the retry runs
    // with fresh (non-drifting) hashes and returns the empty list normally.
    if (list.length === 0 && this.versionDrifted) {
      throw new WodifyDriftError(
        'schedule',
        'schedule returned an empty list while version drift was detected — hashes are likely stale',
      );
    }
    return list;
  }

  // --- Pre-Booking ---

  async getClassAccess(classId: string, programId: string): Promise<ClassAccessResponse['data']> {
    await this.ensureAuthenticated();

    const path =
      '/OnlineSalesPage/screenservices/OnlineSalesPage_CW/Classes/MembershipType/DataActionGetClassAccess_InMembershipType';

    const res = await this.request<ClassAccessResponse>(path, {
      versionInfo: this.getVI('classAccess'),
      viewName: VIEW_NAME,
      screenData: {
        variables: {
          LoggedIn_UserId: this.session.userId,
          LoggedIn_GlobalUserId: this.session.globalUserId,
          LoggedIn_Email: this.config.email,
          Customer: this.session.customer,
          LocationId: this.config.locationId,
          ClassId: classId,
          HasProgramAccess: true,
          SelectedMembershipId: '0',
          ReservationOpenDateTime: new Date().toISOString(),
          FilterProgramId: programId,
        },
      },
      clientVariables: this.getClientVariables(),
    });

    return res.data;
  }

  /**
   * Get available memberships for a class via the two-step OutSystems data action chain.
   * Requires versionHashes.membershipClass in config.
   *
   * Step 1: DataActionGet_Class_InMembershipType — populates class screen variables
   * Step 2: DataActionGetClassAccess_InMembershipType — returns MembershipsAvailable.List
   *
   * Cannot call step 2 cold — it reads class data from screen state set by step 1.
   */
  async getClassMemberships(classId: string, programId: string): Promise<MembershipInfo[]> {
    await this.ensureAuthenticated();

    const membershipCv = this.getMembershipClientVariables();
    const baseScreenVars = {
      FilterProgramId: programId,
      LoggedIn_UserId: this.session.userId,
      LoggedIn_GlobalUserId: this.session.globalUserId,
      LoggedIn_Email: this.config.email,
      Customer: this.session.customer,
      LocationId: this.config.locationId,
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

    // Step 1: Fetch class details — its output feeds into GetClassAccess
    const step1Path =
      '/OnlineSalesPage/screenservices/OnlineSalesPage_CW/Classes/MembershipType/DataActionGet_Class_InMembershipType';
    const step1 = await this.request<{ data: unknown }>(step1Path, {
      versionInfo: this.getMembershipVI('membershipClass'),
      viewName: VIEW_NAME,
      screenData: { variables: baseScreenVars },
      clientVariables: membershipCv,
    });

    // Step 2: Merge class data into screen vars, then call GetClassAccess
    const fullScreenVars = {
      ...baseScreenVars,
      Get_Class_InMembershipType: step1.data,
      _classIdInDataFetchStatus: 1,
      _locationIdInDataFetchStatus: 1,
      _customerInDataFetchStatus: 1,
      _showBookingListInDataFetchStatus: 1,
      _isToViewPurchaseOnlyInDataFetchStatus: 1,
      _hasProgramAccessInDataFetchStatus: 1,
    };

    const step2Path =
      '/OnlineSalesPage/screenservices/OnlineSalesPage_CW/Classes/MembershipType/DataActionGetClassAccess_InMembershipType';
    const step2 = await this.request<ClassAccessResponse>(step2Path, {
      versionInfo: this.getVI('classAccess'),
      viewName: VIEW_NAME,
      screenData: { variables: fullScreenVars },
      clientVariables: membershipCv,
    });

    return step2.data.MembershipsAvailable.List;
  }

  // --- Booking ---

  async bookClass(classId: string, membershipId: string): Promise<BookClassResponse['data']> {
    await this.ensureAuthenticated();

    const path =
      '/OnlineSalesPage/screenservices/OnlineSalesPage_CW/Classes/MembershipType/ActionBookClassWithExistingMembership';
    console.log(`[wodify] bookClass: classId=${classId} membershipId=${membershipId} userId=${this.session.userId} customer=${this.session.customer} authenticated=${this.session.authenticated}`);
    const res = await this.request<BookClassResponse>(path, {
      versionInfo: this.getVI('booking'),
      viewName: VIEW_NAME,
      inputParameters: {
        Customer: this.session.customer,
        ClassId: classId,
        ApplicationSourceId: APPLICATION_SOURCE_ID,
        UserId: this.session.userId,
        SelectedMembershipId: membershipId,
      },
    });

    console.log(`[wodify] bookClass response: ${JSON.stringify(res.data)}`);

    const bookingErr = readError(res.data, 'booking');
    if (bookingErr.HasError) {
      throw new Error(`Booking failed: ${bookingErr.ErrorMessage}`);
    }

    return res.data;
  }

  // --- Convenience: Full Booking Flow ---

  async bookClassBySchedule(
    classId: string,
    _programId: string,
  ): Promise<{ success: boolean; message: string }> {
    // Use configured membershipId directly — getClassAccess returns {} (known OutSystems issue)
    const membershipId = this.config.membershipId;
    const result = await this.bookClass(classId, membershipId);

    return {
      success: !result.Error.HasError,
      message: result.Error.HasError
        ? result.Error.ErrorMessage
        : result.InfoMessage || 'Successfully booked!',
    };
  }

  // --- Config helpers ---

  getConfig(): WodifyPluginConfig {
    return this.config;
  }

  updateConfig(updates: Partial<WodifyPluginConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}
