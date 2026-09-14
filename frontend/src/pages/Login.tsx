/**
 * Login page — POST /auth/login.
 * Accessible to any unauthenticated user; on success routes into the app shell.
 */
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";

export function LoginPage() {
  const { login, token } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("cashier@harvestlink.local");
  const [password, setPassword] = useState("ChangeMeCashier123!");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (token) {
    return <Navigate to="/" replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await login(email, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-100 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md space-y-4 rounded-lg border border-stone-200 bg-white p-8 shadow-sm"
      >
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Harvestlink</h1>
          <p className="mt-1 text-sm text-stone-600">Sign in to the co-op retail platform</p>
        </div>
        <label className="block text-sm">
          <span className="text-stone-600">Email</span>
          <input
            className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
          />
        </label>
        <label className="block text-sm">
          <span className="text-stone-600">Password</span>
          <input
            className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded bg-stone-900 px-4 py-2 text-white hover:bg-stone-800 disabled:opacity-60"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
