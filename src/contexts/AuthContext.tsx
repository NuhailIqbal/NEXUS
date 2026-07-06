import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";

export interface AuthUser {
  id: string;
  email: string;
  user_metadata: { full_name?: string; company_name?: string };
}

interface AuthContextType {
  user: AuthUser | null;
  session: { access_token: string } | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

const TOKEN_KEY = "nexus_access_token";
const REFRESH_KEY = "nexus_refresh_token";
const USER_KEY = "nexus_user";

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function storeAuthData(accessToken: string, refreshToken: string, user: AuthUser) {
  localStorage.setItem(TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuthData() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp * 1000 < Date.now() + 60_000; // 60s buffer
  } catch {
    return true;
  }
}

async function tryRefresh(): Promise<{ user: AuthUser; access_token: string } | null> {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return null;
  try {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const { access_token, refresh_token, user } = body.data;
    storeAuthData(access_token, refresh_token, user);
    return { user, access_token };
  } catch {
    return null;
  }
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<{ access_token: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      const token = localStorage.getItem(TOKEN_KEY);
      const storedUser = localStorage.getItem(USER_KEY);

      if (token && storedUser) {
        if (!isTokenExpired(token)) {
          setUser(JSON.parse(storedUser));
          setSession({ access_token: token });
          setLoading(false);
          return;
        }
        // Token expired — try refresh
        const refreshed = await tryRefresh();
        if (refreshed) {
          setUser(refreshed.user);
          setSession({ access_token: refreshed.access_token });
          setLoading(false);
          return;
        }
      }

      clearAuthData();
      setLoading(false);
    };

    init();
  }, []);

  const signOut = useCallback(async () => {
    clearAuthData();
    setUser(null);
    setSession(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};
