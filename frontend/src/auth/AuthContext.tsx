/**
 * Auth + active-store context for Harvestlink.
 * Holds the logged-in user from POST /auth/login and the store scope used by
 * COOP_ADMIN callers (who must pass storeId on inventory/sales/settlement).
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  apiRequest,
  clearSession,
  getActiveStoreId,
  getStoredUser,
  getToken,
  setActiveStoreId,
  setSession,
} from "../api/client";
import type { AuthUser, Role } from "../api/types";

type AuthState = {
  user: AuthUser | null;
  token: string | null;
  activeStoreId: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setStoreId: (storeId: string) => void;
  isRole: (...roles: Role[]) => boolean;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getToken());
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser<AuthUser>());
  const [activeStoreId, setActiveStoreIdState] = useState<string | null>(() => {
    const stored = getActiveStoreId();
    const u = getStoredUser<AuthUser>();
    return stored ?? u?.storeId ?? null;
  });

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiRequest<{ token: string; user: AuthUser }>("/auth/login", {
      method: "POST",
      body: { email, password },
      auth: false,
    });
    setSession(data.token, data.user);
    setToken(data.token);
    setUser(data.user);
    const storeId = data.user.storeId ?? getActiveStoreId();
    if (storeId) {
      setActiveStoreId(storeId);
      setActiveStoreIdState(storeId);
    }
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setToken(null);
    setUser(null);
  }, []);

  const setStoreId = useCallback((storeId: string) => {
    setActiveStoreId(storeId);
    setActiveStoreIdState(storeId);
  }, []);

  const isRole = useCallback(
    (...roles: Role[]) => (user ? roles.includes(user.role) : false),
    [user],
  );

  const value = useMemo(
    () => ({ user, token, activeStoreId, login, logout, setStoreId, isRole }),
    [user, token, activeStoreId, login, logout, setStoreId, isRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
