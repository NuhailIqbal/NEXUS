/**
 * Client-side auth state for the whole app: <AuthProvider> holds the signed-in user and JWT,
 * and useAuth() exposes them with signIn/signUp/signOut. Talks to the FastAPI backend through
 * api.login / api.register / api.getMe (/auth/login, /auth/register, /auth/me); the JWT is kept
 * in localStorage via getStoredToken/setStoredToken. Mounted in App.tsx inside the router;
 * consumed by DashboardLayout (login gate), Login, Register, Navbar, Profile and QuickSetup.
 * Also installs the admin "view as user" impersonation token handed over in the URL.
 */
import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api, getStoredToken, setStoredToken } from "@/services/api";
import { clearImpersonation, markImpersonating } from "@/lib/impersonation";

/** Signed-in user as kept in context; `user_metadata.full_name` (from the profile) is the display name. */
interface AuthUser {
  id: string;
  email: string;
  user_metadata?: { full_name?: string; [k: string]: unknown };
}

/**
 * Value exposed by useAuth(). `loading` stays true until the initial stored-token check
 * finishes, so guards must wait for it before redirecting. `session` carries only the raw JWT.
 * signIn/signUp never throw: they resolve to `{ error }` (null on success); signUp additionally
 * reports `pending` (email verification required) and `devVerifyUrl` (only when the server
 * could not send the verification email).
 */
interface AuthContextType {
  user: AuthUser | null;
  session: { access_token: string } | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string, fullName?: string, recaptchaToken?: string, referralCode?: string) => Promise<{ error: string | null; pending?: boolean; devVerifyUrl?: string }>;
  signOut: () => Promise<void>;
}

/**
 * The context itself. The default value is only seen by components rendered outside
 * <AuthProvider>: no user, `loading` true forever, and every action returns a "not ready" error.
 */
const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  signIn: async () => ({ error: "not ready" }),
  signUp: async () => ({ error: "not ready" }),
  signOut: async () => {},
});

/** Hook returning the current auth state and actions; see AuthContextType. */
export const useAuth = () => useContext(AuthContext);

// Compatibility helpers used by a few pages. A single token system is used
// (via api's getStoredToken/setStoredToken); these are thin wrappers over it.
/**
 * Persists the access token only. The refresh-token and user parameters are accepted but
 * ignored because a single JWT is used (see the compatibility note above). It does not
 * update React state. Currently imported by Login.tsx but not called anywhere.
 */
export function storeAuthData(accessToken: string, _refreshToken?: string, _user?: AuthUser) {
  setStoredToken(accessToken);
}

/**
 * Removes the stored token and the impersonation flag from localStorage. Unlike signOut it
 * does not reset the provider's user/session state, so the in-memory user remains until the next reload.
 */
export function clearAuthData() {
  setStoredToken(null);
  clearImpersonation();
}

/**
 * Provider that owns the auth state. On mount it (1) adopts an admin impersonation token from
 * the URL if present, then (2) validates any stored token with GET /auth/me and fills `user`.
 * `loading` flips to false once that check ends, whether or not a user was found.
 */
export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<{ access_token: string } | null>(null);
  const [loading, setLoading] = useState(true);

  // On load, if we have a stored token, resolve the current user.
  useEffect(() => {
    // Admin "view as user" handoff: admin.edmnexus.ai is a different origin than the
    // dashboard in production, so the impersonation token arrives via URL instead of
    // shared localStorage. Install it, then strip it from the address bar immediately.
    const params = new URLSearchParams(window.location.search);
    const impersonateToken = params.get("impersonate_token");
    const impersonateEmail = params.get("impersonate_email");
    if (impersonateToken && impersonateEmail) {
      setStoredToken(impersonateToken);
      markImpersonating(impersonateEmail);
      window.history.replaceState({}, "", window.location.pathname);
    }

    // Must come after the impersonation handoff above so the token just installed is the one resolved.
    const token = getStoredToken();
    if (!token) {
      setLoading(false);
      return;
    }
    // Session is set optimistically from the stored token; `user` stays null (and `loading`
    // true) until /auth/me confirms the token below.
    setSession({ access_token: token });
    api.getMe().then(({ data, error }) => {
      // request() also reports network failures through `error`, so any failed /auth/me
      // (not only a 401) discards the stored token.
      if (data && !error) {
        setUser({
          id: data.id,
          email: data.email,
          user_metadata: { full_name: data.profile?.full_name },
        });
      } else {
        // Token invalid/expired — clear it (and any impersonation bookkeeping,
        // so a stale banner can't reappear over the next real session).
        setStoredToken(null);
        setSession(null);
        clearImpersonation();
      }
      setLoading(false);
    });
  }, []);

  /**
   * Logs in with POST /auth/login, stores the returned JWT and loads the profile via /auth/me.
   * Resolves to `{ error }`: the backend's message (e.g. wrong credentials, or the account's
   * email not yet verified) is passed through as the string.
   */
  const signIn = async (email: string, password: string) => {
    const { data, error } = await api.login({ email, password });
    if (error || !data?.access_token) return { error: error || "Login failed" };
    // A real login is never an impersonation — drop any leftover flag.
    clearImpersonation();
    setStoredToken(data.access_token);
    setSession({ access_token: data.access_token });
    // Resolve the profile so the display name (full_name) is available
    // immediately — otherwise the UI briefly falls back to the raw email.
    const me = await api.getMe();
    if (me.data && !me.error) {
      setUser({
        id: me.data.id,
        email: me.data.email,
        user_metadata: { full_name: me.data.profile?.full_name },
      });
    } else {
      // The login itself succeeded, so stay signed in using the id/email from the login
      // response, just without a display name.
      setUser({ id: data.user?.id ?? "", email: data.user?.email ?? email, user_metadata: {} });
    }
    return { error: null };
  };

  /**
   * Registers via POST /auth/register but does NOT sign the user in (no token is issued until
   * the email is verified). `app_url` is the current origin so the emailed verification link
   * points back at this host. `recaptchaToken` is checked server-side when reCAPTCHA is
   * configured; `referralCode` is optional.
   */
  const signUp = async (email: string, password: string, fullName?: string, recaptchaToken?: string, referralCode?: string) => {
    const { data, error } = await api.register({
      email,
      password,
      full_name: fullName,
      app_url: window.location.origin,
      recaptcha_token: recaptchaToken,
      referral_code: referralCode,
    });
    if (error) return { error };
    // Account created UNVERIFIED — the user must click the emailed link before they
    // can log in. Surface the pending state (+ a dev link when no email was sent).
    return { error: null, pending: true, devVerifyUrl: data?.dev_verify_url };
  };

  /**
   * Signs out locally only: clears the stored token, impersonation flag and state. No backend
   * call is made (JWTs are stateless; the backend's /auth/logout is a no-op). `async` just
   * matches the Promise<void> in AuthContextType.
   */
  const signOut = async () => {
    setStoredToken(null);
    setSession(null);
    setUser(null);
    clearImpersonation();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};
