/**
 * Login page — POST /auth/login.
 * Seeded accounts with mustChangePassword must set a new password before entering the app.
 */
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";

export function LoginPage() {
  const { login, changePassword, token, user, logout } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("cashier@harvestlink.local");
  const [password, setPassword] = useState("ChangeMeCashier123!");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const needsPasswordChange = Boolean(token && user?.mustChangePassword);

  if (token && user && !user.mustChangePassword) {
    return <Navigate to="/" replace />;
  }

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const loggedIn = await login(email, password);
      if (loggedIn.mustChangePassword) {
        setCurrentPassword(password);
        return;
      }
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setPending(false);
    }
  }

  async function onChangePassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }
    setPending(true);
    try {
      await changePassword(currentPassword || password, newPassword);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Password change failed");
    } finally {
      setPending(false);
    }
  }

  if (needsPasswordChange) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-100 px-4">
        <form
          onSubmit={onChangePassword}
          className="w-full max-w-md space-y-4 rounded-lg border border-stone-200 bg-white p-8 shadow-sm"
        >
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Change password</h1>
            <p className="mt-1 text-sm text-stone-600">
              Seeded accounts must set a new password before continuing.
            </p>
          </div>
          <label className="block text-sm">
            <span className="text-stone-600">Current password</span>
            <input
              className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <label className="block text-sm">
            <span className="text-stone-600">New password (min 12 characters)</span>
            <input
              className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
            />
          </label>
          <label className="block text-sm">
            <span className="text-stone-600">Confirm new password</span>
            <input
              className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
            />
          </label>
          {error && <p className="text-sm text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded bg-stone-900 px-4 py-2 text-white hover:bg-stone-800 disabled:opacity-60"
          >
            {pending ? "Saving…" : "Update password"}
          </button>
          <button
            type="button"
            className="w-full text-sm text-stone-600 underline"
            onClick={() => logout()}
          >
            Sign out
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-100 px-4">
      <form
        onSubmit={onLogin}
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
