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
  private tokenRefreshPromise: Promise<string | null> | null = null;
  private syncChannel: BroadcastChannel | null = null;

  constructor() {
    this.baseUrl = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_NEON_AUTH_URL) ||
      DEFAULT_AUTH_URL;

    this.currentSession = this.loadStoredSession();

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key === STORAGE_KEYS.SESSION) {
          this.currentSession = this.loadStoredSession();
          this.notifyListeners();
        }
      });

      if (typeof BroadcastChannel !== 'undefined') {
        try {
          this.syncChannel = new BroadcastChannel('aira_neon_auth_sync');
          this.syncChannel.onmessage = (event) => {
            if (event.data?.type === 'AUTH_SYNC') {
              this.currentSession = this.loadStoredSession();
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
   */
  public async getValidJwt(): Promise<string | null> {
    if (!this.currentSession || !this.currentSession.token) {
      return null;
    }

    const now = Date.now();
    const expiresAt = this.currentSession.jwtExpiresAt || 0;

    // If we have a valid JWT with more than 60s life, reuse it
    if (this.currentSession.jwt && expiresAt - now > 60_000) {
      return this.currentSession.jwt;
    }

    // Concurrency control: coalesce multiple parallel refresh requests
    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    this.tokenRefreshPromise = (async () => {
      try {
        const { token, expiresAt: newExp } = await this.fetchJwtToken(
          this.currentSession!.token,
          this.currentSession!.cookie
        );
        if (this.currentSession) {
          this.currentSession.jwt = token;
          this.currentSession.jwtExpiresAt = newExp;
          this.saveSession({ ...this.currentSession });
        }
        return token;
      } catch (err) {
        console.warn('Failed to refresh Neon Auth JWT:', err);
        // Security requirement: Never return a stale, expired token on refresh failure
        if (this.currentSession?.jwt && (this.currentSession.jwtExpiresAt || 0) > Date.now()) {
          return this.currentSession.jwt;
        }
        return null;
      } finally {
        this.tokenRefreshPromise = null;
      }
    })();

    return this.tokenRefreshPromise;
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
   */
  public async signOut(): Promise<void> {
    const sessionToken = this.currentSession?.token;
    const cookie = this.currentSession?.cookie;
    const origin = (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost:5173';

    this.saveSession(null);

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

        await fetch(`${this.baseUrl}/sign-out`, {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify({})
        });
      } catch (err) {
        console.warn('Neon Auth remote signout notice:', err);
      }
    }
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

/**
 * Universal authenticated API fetch helper.
 * When logged into Neon Auth, automatically attaches Bearer JWT header.
 * When in guest mode, uses same-origin credentials for signed session cookies.
 */
export async function authenticatedApiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const jwt = await neonAuth.getValidJwt().catch(() => null);

  if (jwt && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${jwt}`);
  }

  return fetch(input, {
    ...init,
    headers,
    credentials: init.credentials || 'same-origin'
  });
}
