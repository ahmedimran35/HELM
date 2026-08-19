// AuthContext — single source of truth on the client for "who is logged in
// and what role do they have". On boot we hit /api/me once; from then on we
// re-fetch whenever:
//   - the user logs in
//   - the user logs out
//   - the api client fires `helm:unauthenticated` (cookie expired)
//
// Role is always re-read from the server — the docs explicitly require
// that a role change made by another admin takes effect on the user's
// next request, with no token refresh needed.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { apiGet, apiPost } from "../api/client";

export type Role = "admin" | "user";

export interface CurrentUser {
  id: string;
  username: string;
  name: string;
  role: Role;
  must_change_password: boolean;
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  bootstrapped: boolean | null;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<CurrentUser>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

// All client-side state we own lives under the `helm.` prefix in
// localStorage. On logout (or session-expiry) we wipe those keys so a
// different account signing in on the same browser doesn't inherit the
// previous user's theme, recents, draft inputs, etc.
function clearHelmStorage() {
  try {
    const keys = Object.keys(window.localStorage).filter((k) =>
      k.startsWith("helm."),
    );
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    /* localStorage may be unavailable — best effort */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootstrapped, setBootstrapped] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await apiGet<CurrentUser>("/me");
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  // Boot: check whether first-boot seeding has happened (drives login-page
  // hint), then load current user.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await apiGet<{ bootstrapped: boolean }>(
          "/bootstrap-status",
        );
        if (!cancelled) setBootstrapped(status.bootstrapped);
      } catch {
        if (!cancelled) setBootstrapped(null);
      }
      try {
        const me = await apiGet<CurrentUser>("/me");
        if (!cancelled) setUser(me);
      } catch {
        if (!cancelled) setUser(null);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen for api-client 401 events and clear the user + their local
  // state. The RequireAuth route guard in App.tsx then bounces the user
  // to /login once React re-renders.
  useEffect(() => {
    const handler = () => {
      clearHelmStorage();
      setUser(null);
    };
    window.addEventListener("helm:unauthenticated", handler);
    return () => window.removeEventListener("helm:unauthenticated", handler);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiPost<{ user: CurrentUser }>("/login", {
      username,
      password,
    });
    // Re-fetch /me so we get the canonical server-side role + name.
    const me = await apiGet<CurrentUser>("/me");
    setUser(me);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiPost("/logout");
    } finally {
      clearHelmStorage();
      setUser(null);
    }
  }, []);

  return (
    <Ctx.Provider value={{ user, loading, bootstrapped, refresh, login, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}