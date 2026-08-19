import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { CallSign } from "../components/ui/CallSign";
import { Badge } from "../components/ui/Badge";
import { Skeleton } from "../components/ui/feedback/Skeleton";

/**
 * Login — single page for everyone. The same form serves admin and user;
 * the role is looked up server-side and the shell renders accordingly.
 * If `must_change_password` is true on the response, we redirect into a
 * forced password-change gate before reaching the app.
 */
export function LoginPage() {
  const { login, user, bootstrapped } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // If somehow already logged in, send to the app. The redirect must run
  // in an effect — calling navigate during render triggers a "Cannot
  // update a component while rendering a different component" warning.
  useEffect(() => {
    if (user) {
      navigate(user.must_change_password ? "/change-password" : "/", {
        replace: true,
      });
    }
  }, [user, navigate]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const u = await login(username.trim(), password);
      navigate(u.must_change_password ? "/change-password" : "/", {
        replace: true,
      });
    } catch (err) {
      setError((err as Error).message || "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-full h-full flex items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[380px]">
        {/* Brand mark — same as sidebar but at full hero size */}
        <div className="flex items-baseline gap-3">
          <h1 className="font-display font-bold tracking-[0.22em] text-text text-[40px] leading-none">
            HELM
          </h1>
          <div className="flex items-center gap-2">
            <CallSign id="OPS-01" />
          </div>
        </div>
        <p className="mt-2 text-textMuted text-[13px]">
          Governed multiplayer AI workspace.
        </p>

        <form
          onSubmit={onSubmit}
          className="mt-8 border border-border bg-panel p-5"
        >
          <div className="flex items-center justify-between mb-4">
            <span className="mono-caps text-[11px] text-textMuted">
              Sign in
            </span>
            <Badge tone="brass">v0.1</Badge>
          </div>

          <div className="space-y-3">
            <Input
              label="Username"
              name="username"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <Input
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <div className="mt-3 mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
              {error}
            </div>
          )}

          <Button
            variant="primary"
            size="md"
            type="submit"
            disabled={submitting || !username || !password}
            className="mt-4 w-full"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </Button>

          {bootstrapped === null ? (
            <Skeleton variant="text" width="90%" className="mt-4 mx-auto" />
          ) : bootstrapped === true ? (
            <p className="mt-4 mono-caps text-[10px] text-textFaint leading-relaxed">
              First-boot admin already exists. New accounts are created from
              inside the admin panel only — there is no public sign-up.
            </p>
          ) : (
            <p className="mt-4 mono-caps text-[10px] text-brass leading-relaxed">
              First-boot: ADMIN_USERNAME / ADMIN_PASSWORD from the server .env
              are seeded on first launch.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}