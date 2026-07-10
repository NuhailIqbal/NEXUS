import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api, getStoredToken, setStoredToken } from "@/services/api";

interface AuthUser {
  id: string;
  email: string;
  user_metadata?: { full_name?: string; [k: string]: unknown };
}

interface AuthContextType {
  user: AuthUser | null;
  session: { access_token: string } | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string, fullName?: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  signIn: async () => ({ error: "not ready" }),
  signUp: async () => ({ error: "not ready" }),
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

// Compatibility helpers used by a few pages. A single token system is used
// (via api's getStoredToken/setStoredToken); these are thin wrappers over it.
export function storeAuthData(accessToken: string, _refreshToken?: string, _user?: AuthUser) {
  setStoredToken(accessToken);
}

export function clearAuthData() {
  setStoredToken(null);
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<{ access_token: string } | null>(null);
  const [loading, setLoading] = useState(true);

  // On load, if we have a stored token, resolve the current user.
  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setLoading(false);
      return;
    }
    setSession({ access_token: token });
    api.getMe().then(({ data, error }) => {
      if (data && !error) {
        setUser({
          id: data.id,
          email: data.email,
          user_metadata: { full_name: data.profile?.full_name },
        });
      } else {
        // Token invalid/expired — clear it.
        setStoredToken(null);
        setSession(null);
      }
      setLoading(false);
    });
  }, []);

  const signIn = async (email: string, password: string) => {
    const { data, error } = await api.login({ email, password });
    if (error || !data?.access_token) return { error: error || "Login failed" };
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
      setUser({ id: data.user?.id ?? "", email: data.user?.email ?? email, user_metadata: {} });
    }
    return { error: null };
  };

  const signUp = async (email: string, password: string, fullName?: string) => {
    const { data, error } = await api.register({ email, password, full_name: fullName });
    if (error || !data?.access_token) return { error: error || "Registration failed" };
    // Account created but intentionally NOT signed in — the user must log in
    // explicitly on the login page.
    return { error: null };
  };

  const signOut = async () => {
    setStoredToken(null);
    setSession(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};
