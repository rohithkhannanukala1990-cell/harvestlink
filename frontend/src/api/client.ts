/**
 * Fetch wrapper for the Harvestlink backend.
 * Attaches the JWT Bearer token and redirects to /login on 401 so expired sessions
 * cannot keep calling protected POS / settlement APIs with a dead token.
 */
const TOKEN_KEY = "harvestlink.token";
const USER_KEY = "harvestlink.user";
const STORE_KEY = "harvestlink.activeStoreId";

export const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setSession(token: string, user: unknown): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getStoredUser<T>(): T | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function getActiveStoreId(): string | null {
  return localStorage.getItem(STORE_KEY);
}

export function setActiveStoreId(storeId: string | null): void {
  if (storeId) localStorage.setItem(STORE_KEY, storeId);
  else localStorage.removeItem(STORE_KEY);
}

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  /** Skip Authorization header (login). */
  auth?: boolean;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, auth = true, headers, ...rest } = options;
  const token = getToken();

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(
      0,
      `Cannot reach the API at ${API_BASE}. Is the backend running, and is this page’s origin allowed by CORS?`,
    );
  }

  if (res.status === 401) {
    clearSession();
    if (!window.location.pathname.startsWith("/login")) {
      window.location.assign("/login");
    }
    throw new ApiError(401, "Unauthorized");
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const data: unknown = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = data as { error?: string; details?: unknown };
    throw new ApiError(res.status, err.error ?? `Request failed (${res.status})`, err.details);
  }

  return data as T;
}

export function money(value: string | number | undefined | null): string {
  const n = Number(value ?? 0);
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export function todayRangeIso(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const to = new Date(from);
  to.setUTCHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}
