/**
 * AIRA AI 2026 — Neon Managed Better Auth Client (First-Party BFF Mode)
 * 
 * Production-ready first-party client integration with Backend-for-Frontend session gateway:
 * - Issues and validates HttpOnly, Secure, SameSite=Lax first-party session cookies.
 * - Eradicates browser localStorage bearer credentials (zero tokens or JWTs stored in browser JS).
 * - Routes sign-in, sign-up, session restoration, and logout through same-origin /api/auth/* endpoints.
 * - Protects against CSRF with strict Origin checks and session-bound CSRF tokens on mutations.
 * - Provides fail-closed authenticatedApiFetch with identity-bound in-flight cancellation and SSE stream safety.
 * - Maintains guest session support and verified guest-to-account linking.
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
  token: string; // Opaque session identifier / BFF marker
  cookie?: string; // Session cookie for server / test environments
  jwt?: string; // EdDSA signed JWT (server / test environments only)
  jwtExpiresAt?: number;
  csrfToken?: string;
}

export interface AuthStateListener {
  (user: NeonUser | null, session: NeonSessionData | null): void;
}

const STORAGE_KEYS = {
  SESSION: 'aira_neon_auth_session_v1'
};

// Staging Neon Auth service URL as configured on branch pr92-commercial-platform-isolated
const nodeProcess = (globalThis as any)?.process;
const DEFAULT_AUTH_URL = nodeProcess?.env?.NEON_AUTH_BASE_URL
  ? nodeProcess.env.NEON_AUTH_BASE_URL
  : (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_NEON_AUTH_URL
    ? (import.meta as any).env.VITE_NEON_AUTH_URL
    : 'https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth');

export class NeonAuthClient {
  private baseUrl: string;
  private currentSession: NeonSessionData | null = null;
  private csrfToken: string | null = null;
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
      this.baseUrl = '';
      if (!this.isBffMode()) {
        console.error('[NeonAuth] CRITICAL: VITE_NEON_AUTH_URL is missing in production environment. Refusing to fallback to staging URL.');
      }
    } else {
      this.baseUrl = configuredUrl || DEFAULT_AUTH_URL;
    }

    // Legacy migration: purge unencrypted session tokens or raw JWTs from previous localStorage implementations
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEYS.SESSION);
        if (raw && (raw.includes('jwt') || raw.includes('eyJ') || raw.includes('neon_sess_tok'))) {
          window.localStorage.removeItem(STORAGE_KEYS.SESSION);
          window.localStorage.removeItem('aira_neon_auth_session');
        }
      } catch {
        // Storage access handled gracefully
      }
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

      // Proactively restore session from first-party HttpOnly cookie on initialization
      this.restoreSession().catch((err) => {
        console.warn('[NeonAuth] Background session restore notice:', err);
      });
    }
  }

  public getApiBase(): string {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin;
    }
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
    return proc?.env?.AIRA_API_URL || proc?.env?.VITE_API_URL || 'http://localhost:3001';
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

  public getCsrfToken(): string | null {
    return this.csrfToken;
  }

  public setCsrfToken(token: string | null): void {
    this.csrfToken = token;
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
      if (parsed && parsed.user) {
        return {
          user: parsed.user,
          token: parsed.token || 'bff_session',
          jwt: parsed.jwt,
          jwtExpiresAt: parsed.jwtExpiresAt
        };
      }
    } catch {
      // Ignore corrupted cache
    }
    return null;
  }

  public saveSession(session: NeonSessionData | null): void {
    const isSameIdentity =
      session !== null &&
      this.currentSession !== null &&
      this.currentSession.user?.id === session.user?.id &&
      this.currentSession.token === session.token;

    const wasVerifiedBff = this.currentSession?.token === 'bff_session' && Boolean(this.currentSession.csrfToken);
    const isVerifiedBff = session?.token === 'bff_session' && Boolean(session.csrfToken);
    const verificationChanged = isSameIdentity && wasVerifiedBff !== isVerifiedBff;

    if (isSameIdentity) {
      // Same-identity renewal: update memory state in place
      this.currentSession = session;
      this.csrfToken = session?.csrfToken || null;
      this.persistSession(session);
      // Cached public user metadata is not verified: notify subscribers when a
      // real first-party BFF session first supplies its server-issued CSRF token.
      if (verificationChanged) this.notifyListeners();
      return;
    }

    // True session transition: login, logout, account switch, or replaced session
    this.authEpoch++;
    this.activeRefresh = null;
    this.currentSession = session;
    if (session?.csrfToken) {
      this.csrfToken = session.csrfToken;
    } else if (!session) {
      this.csrfToken = null;
    }
    this.abortActiveRequests('Session transitioned or invalidated');
    this.persistSession(session);
    this.notifyListeners();

    if (this.syncChannel) {
      try {
        this.syncChannel.postMessage({
          type: 'AUTH_SYNC',
          userId: session?.user?.id || null,
          epoch: this.authEpoch
        });
      } catch {
        // BroadcastChannel failure tolerated
      }
    }
  }

  private persistSession(session: NeonSessionData | null): void {
    if (typeof window === 'undefined') return;
    try {
      if (session && session.user) {
        // In BFF mode: persist ONLY public user profile metadata for instant display hydration.
        // ZERO bearer credentials, ZERO session tokens, and ZERO raw JWTs in localStorage!
        const safeCache = {
          user: session.user
        };
        localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(safeCache));
      } else {
        localStorage.removeItem(STORAGE_KEYS.SESSION);
        localStorage.removeItem('aira_neon_auth_session');
      }
    } catch {
      // LocalStorage access failure
    }
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
    listener(this.getCurrentUser(), this.currentSession);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getCurrentUser(): NeonUser | null {
    return this.currentSession ? this.currentSession.user : null;
  }

  public getVerifiedBffUser(): NeonUser | null {
    const session = this.currentSession;
    // A localStorage profile never contains a CSRF token, so it cannot qualify.
    return session?.token === 'bff_session' && Boolean(session.csrfToken) ? session.user : null;
  }

  public getCurrentSession(): NeonSessionData | null {
    return this.currentSession;
  }

  public isAuthenticated(): boolean {
    return this.currentSession !== null && !!this.currentSession.user;
  }

  /**
   * Fetch an EdDSA signed JWT token for server / test environments via /token.
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

    let exp = Date.now() + 10 * 60 * 1000;
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
      // Default 10m
    }

    return { token: data.token, expiresAt: exp };
  }

  /**
   * Obtain a valid JWT for environments where Bearer headers are needed.
   * In browser BFF mode, HttpOnly cookies authenticate requests automatically.
   */
  public async getValidJwt(): Promise<string | null> {
    if (!this.baseUrl) {
      throw new Error('Neon Auth service is unconfigured in production environment (missing VITE_NEON_AUTH_URL)');
    }

    if (!this.currentSession || !this.currentSession.token) {
      return null;
    }

    // In pure browser BFF mode without direct Neon tokens, cookie handles authentication
    if (this.currentSession.token === 'bff_session' && !this.currentSession.jwt) {
      return null;
    }

    const now = Date.now();
    const expiresAt = this.currentSession.jwtExpiresAt || 0;

    if (this.currentSession.jwt && expiresAt - now > 60_000) {
      return this.currentSession.jwt;
    }

    const currentEpoch = this.authEpoch;
    const currentUserId = this.currentSession.user?.id || '';
    const currentToken = this.currentSession.token;
    const currentCookie = this.currentSession.cookie;

    if (
      this.activeRefresh &&
      this.activeRefresh.epoch === currentEpoch &&
      this.activeRefresh.userId === currentUserId &&
      this.activeRefresh.token === currentToken
    ) {
      return this.activeRefresh.promise;
    }

    if (this.activeRefresh) {
      this.activeRefresh = null;
    }

    const refreshPromise = (async (): Promise<string | null> => {
      try {
        const { token, expiresAt: newExp } = await this.fetchJwtToken(
          currentToken,
          currentCookie
        );

        if (
          this.authEpoch !== currentEpoch ||
          !this.currentSession ||
          (this.currentSession.user?.id || '') !== currentUserId ||
          this.currentSession.token !== currentToken
        ) {
          console.warn('[NeonAuth] In-flight JWT refresh discarded: active session or auth epoch changed during refresh');
          return null;
        }

        this.currentSession.jwt = token;
        this.currentSession.jwtExpiresAt = newExp;
        this.saveSession({ ...this.currentSession });
        return token;
      } catch (err: any) {
        console.warn('Failed to refresh Neon Auth JWT:', err);
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
   * Restore existing session from first-party BFF HttpOnly cookie or bridge active Neon OAuth session.
   */
  public async restoreSession(): Promise<NeonSessionData | null> {
    try {
      // 0. Handle OAuth error query param if user cancelled or error occurred
      if (typeof window !== 'undefined' && window.location?.search) {
        const urlParams = new URLSearchParams(window.location.search);
        const oauthError = urlParams.get('error') || urlParams.get('auth_error');
        if (oauthError) {
          console.warn('[NeonAuth] OAuth return error:', oauthError);
          const cleanUrl = window.location.pathname + window.location.hash;
          window.history.replaceState({}, document.title, cleanUrl);
        }
      }

      // 1. Proactively check existing first-party BFF HttpOnly cookie (__Host-aira_auth_session)
      const res = await fetch(`${this.getApiBase()}/api/auth/session`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include'
      });

      if (res.ok) {
        const data = await res.json();
        if (data.status === 'AUTHENTICATED' && data.user) {
          this.csrfToken = data.csrfToken || null;
          const session: NeonSessionData = {
            user: data.user,
            token: 'bff_session',
            csrfToken: data.csrfToken
          };
          this.saveSession(session);

          // Handle post-OAuth return cleanup and guest conversation linking
          if (typeof window !== 'undefined' && window.location?.search) {
            const hasAuthSuccess = window.location.search.includes('auth_success');
            const hasAuthCallback = window.location.search.includes('auth_callback');
            if (hasAuthSuccess || hasAuthCallback) {
              const cleanUrl = window.location.pathname + window.location.hash;
              window.history?.replaceState({}, document.title, cleanUrl);
              await this.linkGuestSessionToServer().catch((linkErr) => {
                console.warn('[NeonAuth] Post-OAuth guest linking notice:', linkErr?.message || linkErr);
              });
            }
          }

          return session;
        }
      }

      // 2. If first-party cookie was absent, check Neon Auth cross-origin endpoint (/get-session).
      // This handles returning from Google OAuth or cross-domain authentication where Neon Auth
      // established an upstream session cookie (__Secure-neon-auth.session_token).
      if (this.baseUrl) {
        try {
          const origin = (typeof window !== 'undefined' && window.location?.origin)
            ? window.location.origin
            : 'http://localhost:5173';
          const neonRes = await fetch(`${this.baseUrl}/get-session`, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Origin: origin
            },
            credentials: 'include'
          });

          if (neonRes.ok) {
            const neonData = await neonRes.json();
            if (neonData && neonData.session?.token && neonData.user) {
              // Exchange upstream Neon Auth session token for a first-party signed BFF cookie
              const exchangeRes = await fetch(`${this.getApiBase()}/api/auth/oauth-exchange`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-aira-csrf-protection': '1'
                },
                credentials: 'include',
                body: JSON.stringify({
                  sessionToken: neonData.session.token
                })
              });

              if (exchangeRes.ok) {
                const exchangeData = await exchangeRes.json();
                if (exchangeData.status === 'AUTHENTICATED' && exchangeData.user) {
                  this.csrfToken = exchangeData.csrfToken || null;
                  const session: NeonSessionData = {
                    user: exchangeData.user,
                    token: 'bff_session',
                    csrfToken: exchangeData.csrfToken
                  };
                  this.saveSession(session);

                  // Migrate any active guest conversations to the newly authenticated Google account
                  await this.linkGuestSessionToServer().catch((linkErr) => {
                    console.warn('[NeonAuth] Post-OAuth guest linking notice:', linkErr?.message || linkErr);
                  });

                  // Clean up URL if auth_callback parameter was present
                  if (typeof window !== 'undefined') {
                    if (window.location?.search?.includes('auth_callback')) {
                      const cleanUrl = window.location.pathname + window.location.hash;
                      window.history?.replaceState({}, document.title, cleanUrl);
                    }
                    if (window.sessionStorage) {
                      try { sessionStorage.removeItem('aira_oauth_pending'); } catch {}
                    }
                  }

                  return session;
                }
              } else {
                // Fallback to upstream user profile if BFF exchange endpoint is temporarily offline
                const fallbackSession: NeonSessionData = {
                  user: neonData.user,
                  token: neonData.session.token
                };
                this.saveSession(fallbackSession);
                return fallbackSession;
              }
            }
          }
        } catch (neonErr) {
          console.warn('[NeonAuth] Cross-origin session check notice:', neonErr);
        }
      }

      // 3. User is truly anonymous / guest
      if (this.currentSession && this.currentSession.token === 'bff_session') {
        this.saveSession(null);
      }
      return null;
    } catch (err) {
      console.warn('[NeonAuth] Session restore network notice:', err);
      return null;
    }
  }

  private forceBffMode: boolean = false;
  private forceDirectNeon: boolean = false;

  public enableBffMode(enabled: boolean): void {
    this.forceBffMode = enabled;
  }

  public isBffMode(): boolean {
    if (this.forceBffMode) return true;
    if (this.forceDirectNeon) return false;
    // In browser environment without explicit direct mode, always prefer first-party BFF
    if (typeof window !== 'undefined') return true;
    // In Node: if baseUrl points directly to a Neon Auth server, use direct mode
    return !this.baseUrl || !this.baseUrl.includes('neonauth');
  }

  /**
   * Register a new persistent user account through first-party BFF gateway or direct provider.
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
      'x-aira-csrf-protection': '1'
    };
    if (typeof window === 'undefined') {
      headers['Origin'] = origin;
    }

    if (this.isBffMode()) {
      const response = await fetch(`${this.getApiBase()}/api/auth/sign-up`, {
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
        throw new Error(err.message || err.error || `Registration failed with status ${response.status}`);
      }

      const data = await response.json();
      const user: NeonUser = data.user;
      this.csrfToken = data.csrfToken || null;

      const session: NeonSessionData = {
        user,
        token: 'bff_session',
        csrfToken: data.csrfToken
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

    // Direct Neon Auth Service Mode (e.g. for staging integration testing)
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
   * Sign in an existing user through first-party BFF gateway or direct provider.
   */
  public async signIn(params: {
    email: string;
    password: string;
    preserveGuestData?: boolean;
  }): Promise<{ user: NeonUser; session: NeonSessionData }> {
    const origin = (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost:5173';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-aira-csrf-protection': '1'
    };
    if (typeof window === 'undefined') {
      headers['Origin'] = origin;
    }

    if (this.isBffMode()) {
      const response = await fetch(`${this.getApiBase()}/api/auth/sign-in`, {
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
        throw new Error(err.message || err.error || `Sign in failed with status ${response.status}`);
      }

      const data = await response.json();
      const user: NeonUser = data.user;
      this.csrfToken = data.csrfToken || null;

      const session: NeonSessionData = {
        user,
        token: 'bff_session',
        csrfToken: data.csrfToken
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

    // Direct Neon Auth Service Mode
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
   * Initiate third-party social OAuth sign-in flow (Google, GitHub) via Neon Auth.
   */
  public async signInWithSocial(params: {
    provider: 'google' | 'github' | string;
    callbackURL?: string;
    autoRedirect?: boolean;
  }): Promise<{ url: string; redirect: boolean }> {
    if (this.isBffMode()) {
      if (params.provider !== 'google' && params.provider !== 'github') {
        throw new Error('Unsupported OAuth provider');
      }
      const origin = (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost:5173';
      const response = await fetch(`${this.getApiBase()}/api/auth/oauth/${params.provider}/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-aira-csrf-protection': '1',
          'Origin': origin,
        },
        credentials: 'include',
        body: JSON.stringify({
          provider: params.provider,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ message: 'Social OAuth initialization failed' }));
        throw new Error(err.message || err.error || `Social OAuth initialization failed (${response.status})`);
      }

      const data = await response.json();
      if (!data || !data.url) {
        throw new Error('Malformed response from social OAuth start endpoint');
      }

      const autoRedirect = params.autoRedirect !== false;
      if (autoRedirect && typeof window !== 'undefined' && window.location) {
        window.location.href = data.url;
      }

      return {
        url: data.url,
        redirect: data.redirect ?? true,
      };
    }

    if (!this.baseUrl) {
      throw new Error('Neon Auth service is unconfigured in production environment (missing VITE_NEON_AUTH_URL)');
    }

    const origin = (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost:5173';
    const callbackURL = params.callbackURL || `${origin}?auth_callback=1`;

    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        sessionStorage.setItem('aira_oauth_pending', params.provider || 'google');
      } catch {}
    }

    const response = await fetch(`${this.baseUrl}/sign-in/social`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': origin,
      },
      body: JSON.stringify({
        provider: params.provider,
        callbackURL,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: 'Social sign-in request failed' }));
      throw new Error(err.message || err.error || `Social sign-in failed (${response.status})`);
    }

    const data = await response.json();
    if (!data || !data.url) {
      throw new Error('Malformed response from social sign-in provider endpoint');
    }

    const autoRedirect = params.autoRedirect !== false;
    if (autoRedirect && typeof window !== 'undefined' && window.location) {
      window.location.href = data.url;
    }

    return {
      url: data.url,
      redirect: data.redirect ?? true,
    };
  }

  /**
   * Sign out the active session locally and remotely on the BFF or direct provider.
   */
  public async signOut(): Promise<{ remoteSuccess: boolean; error?: string }> {
    const sessionToken = this.currentSession?.token;
    const cookie = this.currentSession?.cookie;
    const csrf = this.csrfToken;
    const origin = (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost:5173';

    // Clear local state first to immediately isolate the browser
    this.saveSession(null);
    this.csrfToken = null;

    let remoteSuccess = true;
    let remoteError: string | undefined;

    if (this.isBffMode()) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        };
        if (typeof window === 'undefined') {
          headers['Origin'] = origin;
        }
        if (csrf) {
          headers['x-csrf-token'] = csrf;
        } else {
          headers['x-aira-csrf-protection'] = '1';
        }

        const res = await fetch(`${this.getApiBase()}/api/auth/sign-out`, {
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

        // Also purge remote Neon Auth session cookie cross-origin to ensure full revocation
        if (this.baseUrl && typeof window !== 'undefined') {
          try {
            await fetch(`${this.baseUrl}/sign-out`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Origin': origin
              },
              credentials: 'include',
              body: JSON.stringify({})
            });
          } catch {}
        }
      } catch (err: any) {
        remoteSuccess = false;
        remoteError = err?.message || 'Remote signout network failure';
        console.warn('Neon Auth remote signout notice:', err);
      }
      return { remoteSuccess, error: remoteError };
    }

    // Direct Neon Auth Service Mode
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
   * Explicitly revoke the session both remotely on the first-party BFF and locally.
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
   * Proves that the cookie session or bearer JWT successfully bound to ExecutionPrincipal.
   */
  public async verifyServerIdentity(): Promise<{
    status: string;
    userId: string;
    provider: string;
    email?: string;
    name?: string;
  }> {
    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };
    const jwt = await this.getValidJwt();
    if (jwt) {
      headers['Authorization'] = `Bearer ${jwt}`;
    }

    const response = await fetch(`${this.getApiBase()}/api/auth/identity`, {
      method: 'GET',
      headers,
      credentials: 'include'
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Server identity verification failed (${response.status}): ${text}`);
    }

    return response.json();
  }

  /**
   * Link existing signed guest session data to the authenticated user account on the server.
   */
  public async linkGuestSessionToServer(): Promise<{ success: boolean; transferredConversations: number }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.csrfToken) {
      headers['x-csrf-token'] = this.csrfToken;
    } else {
      headers['x-aira-csrf-protection'] = '1';
    }

    const jwt = await this.getValidJwt();
    if (jwt) {
      headers['Authorization'] = `Bearer ${jwt}`;
    }

    const response = await fetch(`${this.getApiBase()}/api/auth/link-guest`, {
      method: 'POST',
      headers,
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
 * - Revalidates immediately after token check; aborts dispatch if identity transitioned.
 * - Manages in-flight AbortControllers tied to the initiating auth epoch.
 * - Revalidates identity upon network response resolution; discards responses from obsolete sessions.
 * - Wraps streaming response bodies with identityBoundStream to keep cancellation active.
 * - Attaches session CSRF tokens on mutating requests (POST, PUT, DELETE).
 * - Enforces zero-bearer-token client security in browser BFF mode using HttpOnly cookies.
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
    const isDirectNeonSession = Boolean(initiatingSession?.token && initiatingSession.token !== 'bff_session');
    const hasExplicitJwt = Boolean(initiatingSession?.jwt);

    if (isDirectNeonSession || hasExplicitJwt || typeof window === 'undefined') {
      try {
        jwt = await neonAuth.getValidJwt();
      } catch (err) {
        console.error('[authenticatedApiFetch] Managed account JWT retrieval failed:', err);
        throw new AuthenticationRequiredError(
          'Failed to obtain valid session credentials for managed account. Re-authentication required.'
        );
      }
    }

    // Pre-dispatch revalidation: verify that authentication state, epoch, and user ID did NOT change
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

    // When direct session token or explicit JWT is present, require resolved JWT to be non-null
    if ((isDirectNeonSession || hasExplicitJwt) && !jwt) {
      throw new AuthenticationRequiredError(
        'Account session expired or token is invalid. Please sign in again.'
      );
    }

    const headers = new Headers(init.headers || {});
    if (jwt) {
      headers.set('Authorization', `Bearer ${jwt}`);
    }

    // Attach CSRF protection headers on state-changing requests
    const method = (init.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrf = neonAuth.getCsrfToken();
      if (csrf && !headers.has('X-CSRF-Token')) {
        headers.set('X-CSRF-Token', csrf);
      }
      if (!headers.has('X-Aira-Csrf-Protection')) {
        headers.set('X-Aira-Csrf-Protection', '1');
      }
    }

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
        credentials: init.credentials || 'include',
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
  if (neonAuth.isAuthenticated()) {
    return authenticatedApiFetch(input, init, options);
  }

  await ensureGuestSession();

  if (neonAuth.isAuthenticated()) {
    return authenticatedApiFetch(input, init, options);
  }

  const headers = new Headers(init.headers || {});
  let res = await fetch(input, {
    ...init,
    headers,
    credentials: init.credentials || 'include',
    signal: options?.signal || init.signal
  });

  if (neonAuth.isAuthenticated()) {
    throw new AuthenticationRequiredError(
      'Account authentication established while guest operation was in-flight; guest response discarded.'
    );
  }

  if (res.status === 401) {
    await ensureGuestSession(true);
    if (neonAuth.isAuthenticated()) {
      return authenticatedApiFetch(input, init, options);
    }
    res = await fetch(input, {
      ...init,
      headers,
      credentials: init.credentials || 'include',
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
