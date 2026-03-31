// Wodify API request/response types
// Based on reverse-engineered OutSystems Reactive endpoints

// --- Common ---

export interface VersionInfo {
  moduleVersion: string;
  apiVersion: string;
}

export interface WodifyError {
  HasError: boolean;
  ErrorMessage: string;
}

// --- Auth ---

export interface EmailLookupRequest {
  versionInfo: VersionInfo;
  viewName: string;
  inputParameters: {
    Request: {
      Email: string;
    };
  };
}

export interface EmailLookupResponse {
  data: {
    Response: {
      Customer: string;
      GlobalUserFirstName: string;
      GlobalUserLastName: string;
      GlobalUserId: string;
      UserId: string;
      HasMFARequiredRole: boolean;
      IsRequiresConfirmation: boolean;
      Error: WodifyError;
    };
  };
}

export interface LoginRequest {
  versionInfo: VersionInfo;
  viewName: string;
  inputParameters: {
    UserName: string;
    Password: string;
    ApplicationSourceId: number;
    CustomerId: string;
    SkipPasswordCheck: boolean;
    LoginToken: string;
  };
}

export interface LoginResponse {
  data: {
    ErrorMessage: string;
    IsInactiveClientToBeMerged: boolean;
    GlobalUserIdToBeMerged: string;
    Response_ValidateLogin: {
      GlobalUserId: string;
      GlobalUserStatusId_IsRequireConfirmation: boolean;
      ClientIsSuspended: boolean;
      GlobalUserFirstName: string;
      GlobalUserStatusId_IsConfirmed: boolean;
      GlobalUserStatusId_IsActive: boolean;
      UserId: string;
      CustomerIsSuspended: boolean;
      UserHasGoogleAuthAppConfigured: boolean;
      UserName: string;
      CustomerId: string;
      Customer: string;
      SocialLoginUserId: string;
    };
    UserNeedsMFA: boolean;
  };
}

// --- Schedule ---

export interface ProgramListItem {
  Value: string;
  Label: string;
  IsSelect: boolean;
  ImageUrl: string;
}

export interface ClassScheduleRequest {
  versionInfo: VersionInfo;
  viewName: string;
  screenData: {
    variables: {
      ProgramsList: { List: ProgramListItem[] };
      SelectedProgramList: { List: { Id: string }[] };
      EmployeesList: { List: unknown[] };
      SelectedEmployeesList: { List: unknown[]; EmptyListItem: { Id: string } };
      SelectedDate: string;
      SelectedDate_WeekChange: string;
    };
  };
}

export interface Coach {
  ClassId: number;
  CoachName: string;
  IsHeadCoach: boolean;
  CoachImgUrl: string;
}

export interface WodifyClass {
  Id: number;
  Name: string;
  GymProgramId: string;
  StartDateTime: string;
  StartDate: string;
  StartTime: string;
  EndDateTime: string;
  ClassLimit: number;
  Reserved: number;
  Available: number;
  IsFull: boolean;
  IsCancelled: boolean;
  IsDropInOnline: boolean;
  Description: string;
  Coaches: { List: Coach[] };
  ReservationOpenDateTime: string;
}

export interface ClassScheduleItem {
  Location: { Id: string; Name: string };
  Class: WodifyClass;
  Program: { Id: string; Name: string; Color: string };
}

export interface ClassScheduleResponse {
  data: {
    ClassSchedule: {
      List: ClassScheduleItem[];
    };
  };
}

// --- Pre-Booking (Class Access) ---

export interface ClassAccessResponse {
  data: {
    ClassReservationId: string;
    ClassAccess: {
      CanReserve: boolean;
      CanJoinWaitlist: boolean;
      CanCancelReservation: boolean;
      HasSignedIn: boolean;
      IsBlocked: boolean;
      BlockedText: string;
    };
    MembershipsAvailable: {
      List: MembershipInfo[];
    };
    HasMembershipEnforcement: boolean;
  };
}

export interface MembershipInfo {
  Id: string;
  Name: string;
  Expires: boolean;
  ExpirationDate: string;
  IsSessionBased: boolean;
  IsUnlimited: boolean;
  IsAutoRenew: boolean;
  MemberPlanTypeLabel: string;
  AttendanceLimitationLabel: string;
}

// --- Booking ---

export interface BookClassRequest {
  versionInfo: VersionInfo;
  viewName: string;
  inputParameters: {
    Customer: string;
    ClassId: string;
    ApplicationSourceId: number;
    UserId: string;
    SelectedMembershipId: string;
  };
}

export interface BookClassResponse {
  versionInfo?: { hasModuleVersionChanged: boolean; hasApiVersionChanged: boolean };
  data: {
    InfoMessage: string;
    Error: WodifyError;
  };
}

// --- Session State ---

export interface WodifySession {
  cookies: Map<string, string>;
  csrfToken: string;
  userId: string;
  globalUserId: string;
  customer: string;
  customerId: string;
  authenticated: boolean;
}

// --- Client Variables (OutSystems screen state) ---

export interface WodifyClientVariables {
  IsInMembershipsFlow: boolean;
  CustomerId: string;
  LocationId: number;
  LoggedInGuardianId_Deprecated: string;
  Customer: string;
  PrefilledEmail: string;
  IsHeaderReady: boolean;
  IsWebIntegration: boolean;
}

// --- Version Hashes ---

export interface VersionHashes {
  moduleVersion: string;
  schedule: string;
  emailLookup: string;
  login: string;
  booking: string;
  classAccess: string;
  membershipInit: string;
  membershipClass: string;
  membershipPlans: string;
}

// --- Plugin Config ---

export interface WodifyPluginConfig {
  gymSubdomain: string;
  email: string;
  password: string;
  customerId: string;
  locationId: number;
  customerHex: string;
  membershipId: string;
  versionHashes?: VersionHashes;
}
