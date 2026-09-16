/**
 * Login page — POST /auth/login.
 * Seeded accounts with mustChangePassword must set a new password before entering the app.
 */
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, Card, Field } from "../components/ui";

/** Plain-type stand-in — replace with the real logo file when available; do not redraw the mark. */
function Wordmark({ className = "" }: { className?: string }) {
  return (
    <p className={`text-2xl font-extrabold tracking-tight text-ink ${className}`.trim()}>
      <span>Harvest</span>
      <span className="text-brand-terracotta">Linx</span>
    </p>
  );
}

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
      <div className="flex min-h-screen items-center justify-center bg-surface-page px-4">
        <div className="flex w-full max-w-md flex-col items-center gap-3">
          <Wordmark />
          <p className="font-accent text-[14px] text-ink-muted">
            Member-Owned · Farmer-Connected · Middlemen-Free
          </p>
          <Card className="w-full" title="Change password">
            <form onSubmit={onChangePassword} className="space-y-4">
              <p className="text-sm text-ink-muted">
                Seeded accounts must set a new password before continuing.
              </p>
              <Field
                label="Current password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
              <Field
                label="New password"
                hint="Minimum 12 characters"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={12}
                autoComplete="new-password"
              />
              <Field
                label="Confirm new password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={12}
                autoComplete="new-password"
              />
              {error && (
                <p className="text-sm text-state-danger" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" loading={pending}>
                Update password
              </Button>
              <Button type="button" variant="quiet" className="w-full" onClick={() => logout()}>
                Sign out
              </Button>
            </form>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-page px-4">
      <div className="flex w-full max-w-md flex-col items-center gap-3">
        <Wordmark />
        <p className="font-accent text-[14px] text-ink-muted">
          Member-Owned · Farmer-Connected · Middlemen-Free
        </p>
        <Card className="w-full">
          <form onSubmit={onLogin} className="space-y-4">
            <p className="text-sm text-ink-muted">Sign in to the co-op retail platform</p>
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
            />
            <Field
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              error={error ?? undefined}
            />
            <Button type="submit" className="w-full" loading={pending}>
              Sign in
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
