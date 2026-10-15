/**
 * AIRA AI 2026 — Neon Managed Better Auth Client
 * 
 * Production-ready client integration with Neon's Managed Better Auth service.
 * Supports signup, login, logout, password recovery, session restore,
 * and automatic EdDSA JWT token fetching for backend ExecutionPrincipal binding.
 */

export interface NeonUser {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
  image?: string | null;
  role?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NeonSessionData {
  user: NeonUser;
  token: string; // Better Auth session token
  cookie?: string; // Session cookie for server / test environments
  jwt?: string; // EdDSA signed JWT
  jwtExpiresAt?: number;
}

export interface AuthStateListener {
  (user: NeonUser | null, session: NeonSessionData | null): void;
}

const STORAGE_KEYS = {
  SESSION: 'aira_neon_auth_session_v1'
};

// Staging Neon Auth service URL as configured on branch br-soft-pine-b3gw5nyr
const DEFAULT_AUTH_URL = 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';

export class NeonAuthClient {
  private baseUrl: string;
  private currentSession: NeonSessionData | null = null;
  private listeners: Set<AuthStateListener> = new Set();
  private authEpoch: number = 0;
  private activeRefresh: {
    promise: Promise<string | null>;
    epoch: number;
    userId: string;
    token: string;
  } | null = null;
  private syncChannel: BroadcastChannel | null = null;
  private inFlightRequests: Set<{
    controller: AbortController;
    epoch: number;
    userId: string;
  }> = new Set();

  constructor() {
    const isProd = typeof import.meta !== 'undefined' && Boolean((import.meta as any).env?.PROD);
    const configuredUrl = typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_NEON_AUTH_URL : undefined;

    if (isProd && !configuredUrl) {
      console.error('[NeonAuth] CRITICAL: VITE_NEON_AUTH_URL is missing in production environment. Refusing to fallback to staging URL.');
      this.baseUrl = '';
    } else {
      this.baseUrl = configuredUrl || DEFAULT_AUTH_URL;
    }

    this.currentSession = this.loadStoredSession();

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key === STORAGE_KEYS.SESSION) {
          const newSession = this.loadStoredSession();
          const isSameIdentity =
            this.currentSession &&
            newSession &&
            this.currentSession.user?.id === newSession.user?.id &&
            this.currentSession.token === newSession.token;

          if (!isSameIdentity) {
            this.authEpoch++;
            this.activeRefresh = null;
            this.abortActiveRequests('Cross-tab session change detected');
          }
          this.currentSession = newSession;
          this.notifyListeners();
        }
      });

      if (typeof BroadcastChannel !== 'undefined') {
        try {
          this.syncChannel = new BroadcastChannel('aira_neon_auth_sync');
          this.syncChannel.onmessage = (event) => {
            if (event.data?.type === 'AUTH_SYNC') {
              const newSession = this.loadStoredSession();
              const isSameIdentity =
                this.currentSession &&
                newSession &&
                this.currentSession.user?.id === newSession.user?.id &&
                this.currentSession.token === newSession.token;

              if (!isSameIdentity) {
                this.authEpoch++;
                this.activeRefresh = null;
                this.abortActiveRequests('Cross-tab session change detected');
              }
              this.currentSession = newSession;
              this.notifyListeners();
            }
          };
        } catch {
          // BroadcastChannel unavailable
        }
      }
    }
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  public getAuthEpoch(): number {
    return this.authEpoch;
  }

  /**
   * Register an in-flight API request AbortController bound to an immutable identity epoch.
   * Returns a cleanup callback to unregister once the request terminates.
   */
  public registerInFlightRequest(
    controller: AbortController,
    epoch: number,
    userId: string
  ): () => void {
    const entry = { controller, epoch, userId };
    this.inFlightRequests.add(entry);
    return () => {
      this.inFlightRequests.delete(entry);
    };
  }

  /**
   * Abort all currently in-flight requests bound to obsolete or transitioning auth epochs.
   */
  public abortActiveRequests(reason = 'Authentication state transitioned'): void {
    for (const item of this.inFlightRequests) {
      try {
        item.controller.abort(new Error(reason));
      } catch {
        // Safe catch for already aborted controllers
      }
    }
    this.inFlightRequests.clear();
  }

  private loadStoredSession(): NeonSessionData | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SESSION);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.user && parsed.token) {
        return parsed as NeonSessionData;
      }
    } catch {
      // Ignore corrupted cache
    }
    return null;
  }

  private saveSession(session: NeonSessionData | null): void {
    const isSameIdentity =
      session !== null &&
      this.currentSession !== null &&
      this.currentSession.user?.id === session.user?.id &&
      this.currentSession.token === session.token;

    if (!isSameIdentity) {
      // True session transition: login, logout, account switch, or replaced session
      this.authEpoch++;
      this.activeRefresh = null;
      this.abortActiveRequests('Session transitioned or invalidated');
    }

    this.currentSession = session;
    if (typeof window === 'undefined') return;
    try {
      if (session) {
        localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(session));
      } else {
        localStorage.removeItem(STORAGE_KEYS.SESSION);
      }
      this.syncChannel?.postMessage({ type: 'AUTH_SYNC' });
    } catch {
      // LocalStorage access failure
    }
    this.notifyListeners();
  }

  private notifyListeners(): void {
    const user = this.currentSession ? this.currentSession.user : null;
    for (const listener of this.listeners) {
      try {
        listener(user, this.currentSession);
      } catch (err) {
        console.error('NeonAuth state listener error:', err);
      }
    }
  }

  public onAuthStateChange(listener: AuthStateListener): () => void {
    this.listeners.add(listener);
    // Call immediately with current state
    listener(this.getCurrentUser(), this.currentSession);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getCurrentUser(): NeonUser | null {
    return this.currentSession ? this.currentSession.user : null;
  }

  public getCurrentSession(): NeonSessionData | null {
    return this.currentSession;
  }

  public isAuthenticated(): boolean {
    return this.currentSession !== null && !!this.currentSession.user;
  }

  /**
   * Fetch an EdDSA signed JWT token for the current session via /token.
   */
  public async fetchJwtToken(sessionToken?: string, sessionCookie?: string): Promise<{ token: string; expiresAt: number }> {
    if (!this.baseUrl) {
      throw new Error('Neon Auth service is unconfigured in production environment (missing VITE_NEON_AUTH_URL)');
    }

    const token = sessionToken || this.currentSession?.token;
    const cookie = sessionCookie || this.currentSession?.cookie;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    // In browser, credentials: 'include' automatically sends session cookies.
    // Setting Cookie or Origin manually in browser JavaScript is forbidden by the Fetch standard.
    if (typeof window === 'undefined') {
      if (cookie) {
        headers['Cookie'] = cookie;
      }
      headers['Origin'] = this.baseUrl;
    }

    const response = await fetch(`${this.baseUrl}/token`, {
      method: 'GET',
      headers,
      credentials: 'include'
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Failed to obtain JWT token (${response.status}): ${errorText || response.statusText}`);
    }

    const data = await response.json();
    if (!data || typeof data.token !== 'string') {
      throw new Error('Malformed JWT response from Neon Auth service');
    }

    // Parse expiration from unverified claims segment for proactive refresh scheduling
    let exp = Date.now() + 10 * 60 * 1000; // 10 min default
    try {
      const parts = data.token.split('.');
      if (parts.length === 3) {
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
        const payload = JSON.parse(atob(padded));
        if (payload.exp && typeof payload.exp === 'number') {
          exp = payload.exp * 1000;
        }
      }
    } catch {
      // Fallback to default
    }

    return { token: data.token, expiresAt: exp };
  }

  /**
   * Obtain a verified, unexpired JWT for authenticating API requests.
   * Proactively refreshes if within 60 seconds of expiration.
   * Implements fail-closed concurrency control bound to immutable session identity and authEpoch.
   */
  public async getValidJwt(): Promise<string | null> {
    if (!this.baseUrl) {
      throw new Error('Neon Auth service is unconfigured in production environment (missing VITE_NEON_AUTH_URL)');
    }

    if (!this.currentSession || !this.currentSession.token) {
      return null;
    }

    const now = Date.now();
    const expiresAt = this.currentSession.jwtExpiresAt || 0;

    // If we have a valid JWT with more than 60s life, reuse it
    if (this.currentSession.jwt && expiresAt - now > 60_000) {
      return this.currentSession.jwt;
    }

    const currentEpoch = this.authEpoch;
    const currentUserId = this.currentSession.user?.id || '';
    const currentToken = this.currentSession.token;
    const currentCookie = this.currentSession.cookie;

    // Concurrency control: coalesce multiple parallel refresh requests ONLY if bound to the same identity & epoch
    if (
      this.activeRefresh &&
      this.activeRefresh.epoch === currentEpoch &&
      this.activeRefresh.userId === currentUserId &&
      this.activeRefresh.token === currentToken
    ) {
      return this.activeRefresh.promise;
    }

    // Outdated or mismatched refresh promise detected; discard
    if (this.activeRefresh) {
      this.activeRefresh = null;
    }

    const refreshPromise = (async (): Promise<string | null> => {
      try {
        const { token, expiresAt: newExp } = await this.fetchJwtToken(
          currentToken,
          currentCookie
        );

        // Fail-closed concurrency revalidation:
        // Reject and discard token if identity, session, or auth generation switched while request was in-flight
        if (
          this.authEpoch !== currentEpoch ||
          !this.currentSession ||
          (this.currentSession.user?.id || '') !== currentUserId ||
          this.currentSession.token !== currentToken
        ) {
          console.warn('[NeonAuth] In-flight JWT refresh discarded: active session or auth epoch changed during refresh');
          return null;
        }

        // Apply refreshed JWT to verified current session
        this.currentSession.jwt = token;
        this.currentSession.jwtExpiresAt = newExp;
        this.saveSession({ ...this.currentSession });
        return token;
      } catch (err: any) {
        console.warn('Failed to refresh Neon Auth JWT:', err);
        // If the authentication service rejected the session token with 401, purge the invalid local session
        // ONLY if the active session is still the same session token and identity that was rejected!
        if (err?.message && /401|revoked|invalid/i.test(err.message)) {
          if (
            this.currentSession &&
            this.currentSession.token === currentToken &&
            (this.currentSession.user?.id || '') === currentUserId &&
            this.authEpoch === currentEpoch
          ) {
            console.warn('[NeonAuth] Session token invalid or revoked on server; purging local session');
            this.saveSession(null);
          } else {
            console.warn('[NeonAuth] Delayed revocation for obsolete session ignored; active session preserved');
          }
          return null;
        }
        // Fail-closed fallback: return existing token ONLY if identity still matches and token is unexpired
        if (
          this.authEpoch === currentEpoch &&
          this.currentSession &&
          (this.currentSession.user?.id || '') === currentUserId &&
          this.currentSession.token === currentToken &&
          this.currentSession.jwt &&
          (this.currentSession.jwtExpiresAt || 0) > Date.now()
        ) {
          return this.currentSession.jwt;
        }
        return null;
      } finally {
        if (this.activeRefresh && this.activeRefresh.epoch === currentEpoch && this.activeRefresh.token === currentToken) {
          this.activeRefresh = null;
        }
      }
    })();

    this.activeRefresh = {
      promise: refreshPromise,
      epoch: currentEpoch,
      userId: currentUserId,
      token: currentToken
    };

    return refreshPromise;
  }

  /**
   * Register a new persistent user account with email and password.
   */
  public async signUp(params: {
    email: string;
    password: string;
    name: string;
    preserveGuestData?: boolean;
  }): Promise<{ user: NeonUser; session: NeonSessionData }> {
    const origin = (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost:5173';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (typeof window === 'undefined') {
      headers['Origin'] = origin;
    }

    const response = await fetch(`${this.baseUrl}/sign-up/email`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({
        email: params.email.trim(),
        password: params.password,
        name: params.name.trim()
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: 'Registration failed' }));
      throw new Error(err.message || `Registration failed with status ${response.status}`);
    }

    const data = await response.json();
    const user: NeonUser = data.user;
    const sessionToken: string = data.token;
    const sessionCookie = response.headers.get('set-cookie') || undefined;

    // Fetch matching EdDSA JWT token for immediate API readiness
    const { token: jwt, expiresAt: jwtExpiresAt } = await this.fetchJwtToken(sessionToken, sessionCookie);

    const session: NeonSessionData = {
      user,
      token: sessionToken,
      cookie: sessionCookie,
      jwt,
      jwtExpiresAt
    };

    this.saveSession(session);

    if (params.preserveGuestData) {
      try {
        await this.linkGuestSessionToServer();
      } catch (err) {
        console.warn('Server guest linking notice:', err);
      }
    }

    return { user, session };
  }

  /**
   * Sign in an existing user with email and password.
   */
  public async signIn(params: {
    email: string;
    password: string;
    preserveGuestData?: boolean;
  }): Promise<{ user: NeonUser; session: NeonSessionData }> {
    const origin = (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost:5173';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (typeof window === 'undefined') {
      headers['Origin'] = origin;
    }

    const response = await fetch(`${this.baseUrl}/sign-in/email`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({
        email: params.email.trim(),
        password: params.password
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: 'Sign in failed' }));
      throw new Error(err.message || `Sign in failed with status ${response.status}`);
    }

    const data = await response.json();
    const user: NeonUser = data.user;
    const sessionToken: string = data.token;
    const sessionCookie = response.headers.get('set-cookie') || undefined;

    // Fetch matching EdDSA JWT token for immediate API readiness
    const { token: jwt, expiresAt: jwtExpiresAt } = await this.fetchJwtToken(sessionToken, sessionCookie);

    const session: NeonSessionData = {
      user,
      token: sessionToken,
      cookie: sessionCookie,
      jwt,
      jwtExpiresAt
    };

    this.saveSession(session);

    if (params.preserveGuestData) {
      try {
        await this.linkGuestSessionToServer();
      } catch (err) {
        console.warn('Server guest linking notice:', err);
      }
    }

    return { user, session };
  }

  /**
   * Sign out the active session locally and remotely.
   * Purges local state, increments authEpoch, aborts in-flight requests,
   * and requests server-side session invalidation on the Neon Auth provider.
   */
  public async signOut(): Promise<{ remoteSuccess: boolean; error?: string }> {
    const sessionToken = this.currentSession?.token;
    const cookie = this.currentSession?.cookie;
    const origin = (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost:5173';

    // Clear local state first to immediately isolate the browser
    this.saveSession(null);

    let remoteSuccess = true;
    let remoteError: string | undefined;

    if (sessionToken || cookie) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (typeof window === 'undefined') {
          headers['Origin'] = origin;
          if (cookie) headers['Cookie'] = cookie;
        }
        if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;

        const res = await fetch(`${this.baseUrl}/sign-out`, {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify({})
        });
        if (!res.ok) {
          remoteSuccess = false;
          remoteError = `Remote signout HTTP ${res.status}`;
          console.warn(`[NeonAuth] Remote signout HTTP ${res.status}`);
        }
      } catch (err: any) {
        remoteSuccess = false;
        remoteError = err?.message || 'Remote signout network failure';
        console.warn('Neon Auth remote signout notice:', err);
      }
    }

    return { remoteSuccess, error: remoteError };
  }

  /**
   * Explicitly revoke the session both remotely on the Neon Auth provider and locally.
   */
  public async revokeSession(): Promise<{ remoteSuccess: boolean; error?: string }> {
    return this.signOut();
  }

  /**
   * Request password reset instructions for an account.
   */
  public async requestPasswordReset(email: string): Promise<{ status: boolean; message: string }> {
    const origin = (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost:5173';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (typeof window === 'undefined') {
      headers['Origin'] = origin;
    }
    const response = await fetch(`${this.baseUrl}/request-password-reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: email.trim() })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: 'Password reset request failed' }));
      throw new Error(err.message || `Password reset request failed (${response.status})`);
    }

    const data = await response.json();
    return {
      status: true,
      message: data.message || 'If this email exists in our system, check your email for the reset link'
    };
  }

  /**
   * Reset account password using recovery token.
   */
  public async resetPassword(params: { token: string; newPassword: string }): Promise<{ status: boolean; message?: string }> {
    const origin = (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost:5173';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (typeof window === 'undefined') {
      headers['Origin'] = origin;
    }
    const response = await fetch(`${this.baseUrl}/reset-password`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: 'Password reset failed' }));
      throw new Error(err.message || `Password reset failed (${response.status})`);
    }

    const data = await response.json().catch(() => ({ status: true }));
    return { status: true, message: data.message };
  }

  /**
   * Verify server-side identity resolution against /api/auth/identity.
   * Proves that the bearer JWT successfully bound to ExecutionPrincipal.
   */
  public async verifyServerIdentity(): Promise<{
    status: string;
    userId: string;
    provider: string;
    email?: string;
    name?: string;
  }> {
    const jwt = await this.getValidJwt();
    if (!jwt) throw new Error('No active authenticated session');

    const base = typeof window !== 'undefined' ? '' : ((globalThis as any).process?.env?.AIRA_API_URL || 'http://localhost:3000');
    const response = await fetch(`${base}/api/auth/identity`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${jwt}`
      }
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Server identity verification failed (${response.status}): ${text}`);
    }

    return response.json();
  }

  /**
   * Link existing signed guest session data to the authenticated user account on the server.
   * Invokes POST /api/auth/link-guest which validates both the server-signed guest cookie
   * and the verified managed account JWT.
   */
  public async linkGuestSessionToServer(): Promise<{ success: boolean; transferredConversations: number }> {
    const jwt = await this.getValidJwt();
    if (!jwt) throw new Error('No authenticated user session for linking');

    const base = typeof window !== 'undefined' ? '' : ((globalThis as any).process?.env?.AIRA_API_URL || 'http://localhost:3000');
    const response = await fetch(`${base}/api/auth/link-guest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`
      },
      credentials: 'include',
      body: JSON.stringify({})
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Guest link failed' }));
      throw new Error(err.error || `Guest link failed (${response.status})`);
    }

    return response.json();
  }
}

// Global singleton instance
export const neonAuth = new NeonAuthClient();

export class AuthenticationRequiredError extends Error {
  public readonly isAuthError = true;
  constructor(message = 'Active account session expired or requires re-authentication') {
    super(message);
    this.name = 'AuthenticationRequiredError';
    Object.setPrototypeOf(this, AuthenticationRequiredError.prototype);
  }
}

let guestSessionPromise: Promise<void> | null = null;

export async function ensureGuestSession(force = false): Promise<void> {
  // If user is logged into Neon Auth, never bootstrap or touch a guest session!
  if (neonAuth.isAuthenticated()) {
    return;
  }

  if (force) guestSessionPromise = null;
  if (guestSessionPromise) return guestSessionPromise;

  guestSessionPromise = (async () => {
    try {
      const response = await fetch('/api/auth/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) {
        console.warn(`[ensureGuestSession] Session bootstrap returned ${response.status}`);
      }
    } catch (err) {
      console.warn('[ensureGuestSession] Non-blocking session bootstrap notice:', err);
    }
  })();

  try {
    await guestSessionPromise;
  } catch {
    guestSessionPromise = null;
  }
}

/**
 * Universal authenticated API fetch helper.
 * Fail-closed policy with identity-bound request lifecycle:
 * - Captures immutable user ID, session identity, and auth epoch.
 * - Revalidates immediately after JWT retrieval; aborts dispatch if identity transitioned.
 * - Manages in-flight AbortControllers tied to the initiating auth epoch.
 * - Revalidates identity upon network response resolution; discards responses from obsolete sessions.
 * - Guards against guest bootstrap completing after account login.
 * - When in account mode: REQUIRES a valid unexpired JWT. If JWT cannot be retrieved, or server returns 401,
 *   or identity transitions, throws AuthenticationRequiredError. NEVER silently falls back to anonymous guest cookie!
 */
export async function authenticatedApiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<Response> {
  const initiatingEpoch = neonAuth.getAuthEpoch();
  const initiatingUser = neonAuth.getCurrentUser();
  const initiatingUserId = initiatingUser?.id || '';
  const initiatingSession = neonAuth.getCurrentSession();
  const initiatingSessionToken = initiatingSession?.token || '';
  const isAccountUser = neonAuth.isAuthenticated();

  if (isAccountUser) {
    let jwt: string | null = null;
    try {
      jwt = await neonAuth.getValidJwt();
    } catch (err) {
      console.error('[authenticatedApiFetch] Managed account JWT retrieval failed:', err);
      throw new AuthenticationRequiredError(
        'Failed to obtain valid session credentials for managed account. Re-authentication required.'
      );
    }

    // Pre-dispatch revalidation: verify that authentication state, epoch, and user ID did NOT change during JWT retrieval
    if (
      neonAuth.getAuthEpoch() !== initiatingEpoch ||
      !neonAuth.isAuthenticated() ||
      neonAuth.getCurrentUser()?.id !== initiatingUserId ||
      neonAuth.getCurrentSession()?.token !== initiatingSessionToken
    ) {
      throw new AuthenticationRequiredError(
        'Authentication identity transitioned during token resolution; dispatch aborted to prevent cross-account contamination.'
      );
    }

    if (!jwt) {
      throw new AuthenticationRequiredError(
        'Account session expired or token is invalid. Please sign in again.'
      );
    }

    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${jwt}`);

    // Manage in-flight abort controller bound to initiating identity
    const internalAbortController = new AbortController();
    const cleanupInFlight = neonAuth.registerInFlightRequest(
      internalAbortController,
      initiatingEpoch,
      initiatingUserId
    );

    let effectiveSignal: AbortSignal = internalAbortController.signal;
    const callerSignal = options?.signal || init.signal;
    if (callerSignal) {
      if (typeof (AbortSignal as any).any === 'function') {
        effectiveSignal = (AbortSignal as any).any([callerSignal, internalAbortController.signal]);
      } else {
        callerSignal.addEventListener(
          'abort',
          () => internalAbortController.abort((callerSignal as any).reason),
          { once: true }
        );
      }
    }

    let res: Response;
    try {
      res = await fetch(input, {
        ...init,
        headers,
        credentials: init.credentials || 'same-origin',
        signal: effectiveSignal
      });
    } catch (err: any) {
      cleanupInFlight();
      if (
        neonAuth.getAuthEpoch() !== initiatingEpoch ||
        neonAuth.getCurrentUser()?.id !== initiatingUserId
      ) {
        throw new AuthenticationRequiredError(
          'Authentication identity transitioned while request was in-flight; operation aborted.'
        );
      }
      throw err;
    }

    // Post-response revalidation: verify identity has NOT transitioned while waiting for network response
    if (
      neonAuth.getAuthEpoch() !== initiatingEpoch ||
      !neonAuth.isAuthenticated() ||
      neonAuth.getCurrentUser()?.id !== initiatingUserId ||
      neonAuth.getCurrentSession()?.token !== initiatingSessionToken
    ) {
      cleanupInFlight();
      console.warn('[authenticatedApiFetch] In-flight response discarded: authentication transitioned before response arrival');
      throw new AuthenticationRequiredError(
        'Authentication identity transitioned while request was in-flight; response discarded to prevent cross-account contamination.'
      );
    }

    if (res.status === 401) {
      cleanupInFlight();
      console.warn('[authenticatedApiFetch] Server rejected authentication credentials (401)');
      throw new AuthenticationRequiredError(
        'Server rejected authentication credentials (401). Please re-authenticate.'
      );
    }

    // Wrap streaming response bodies so in-flight abort registration remains active until stream ends
    if (res.body) {
      let isClosed = false;
      const doCleanup = () => {
        if (!isClosed) {
          isClosed = true;
          cleanupInFlight();
        }
      };

      const rawReader = res.body.getReader();
      const identityBoundStream = new ReadableStream({
        async pull(controller) {
          try {
            if (
              neonAuth.getAuthEpoch() !== initiatingEpoch ||
              neonAuth.getCurrentUser()?.id !== initiatingUserId
            ) {
              const abortErr = new AuthenticationRequiredError(
                'Authentication identity transitioned while response stream was active; stream terminated.'
              );
              controller.error(abortErr);
              doCleanup();
              try { await rawReader.cancel(abortErr); } catch {}
              return;
            }

            const { done, value } = await rawReader.read();
            if (done) {
              controller.close();
              doCleanup();
            } else {
              if (
                neonAuth.getAuthEpoch() !== initiatingEpoch ||
                neonAuth.getCurrentUser()?.id !== initiatingUserId
              ) {
                const abortErr = new AuthenticationRequiredError(
                  'Authentication identity transitioned while response stream was active; stream terminated.'
                );
                controller.error(abortErr);
                doCleanup();
                try { await rawReader.cancel(abortErr); } catch {}
                return;
              }
              controller.enqueue(value);
            }
          } catch (err) {
            controller.error(err);
            doCleanup();
          }
        },
        async cancel(reason) {
          doCleanup();
          try { await rawReader.cancel(reason); } catch {}
        }
      });

      internalAbortController.signal.addEventListener('abort', () => {
        doCleanup();
        try { rawReader.cancel(internalAbortController.signal.reason); } catch {}
      }, { once: true });

      return new Response(identityBoundStream, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers
      });
    }

    cleanupInFlight();
    return res;
  }

  // Legitimate Guest User path
  // If user signed in while we entered guest branch, re-check immediately
  if (neonAuth.isAuthenticated()) {
    return authenticatedApiFetch(input, init, options);
  }

  await ensureGuestSession();

  // Guard against user signing in during guest session bootstrap
  if (neonAuth.isAuthenticated()) {
    return authenticatedApiFetch(input, init, options);
  }

  const headers = new Headers(init.headers || {});
  let res = await fetch(input, {
    ...init,
    headers,
    credentials: init.credentials || 'same-origin',
    signal: options?.signal || init.signal
  });

  // Check again after response: if user signed in while guest fetch was in-flight, discard response
  if (neonAuth.isAuthenticated()) {
    throw new AuthenticationRequiredError(
      'Account authentication established while guest operation was in-flight; guest response discarded.'
    );
  }

  if (res.status === 401) {
    // Retry once for legitimate guest session renewal
    await ensureGuestSession(true);
    if (neonAuth.isAuthenticated()) {
      return authenticatedApiFetch(input, init, options);
    }
    res = await fetch(input, {
      ...init,
      headers,
      credentials: init.credentials || 'same-origin',
      signal: options?.signal || init.signal
    });
    if (neonAuth.isAuthenticated()) {
      throw new AuthenticationRequiredError(
        'Account authentication established while guest operation was in-flight; guest response discarded.'
      );
    }
  }

  return res;
}
