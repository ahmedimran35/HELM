import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiPost } from "../api/client";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";

/**
 * Forced change-password gate. Triggered when the user must reset their
 * password (first login, or admin reset). After a successful change we
 * refresh the user via the auth context.
 */
export function ChangePasswordPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!user) {
    navigate("/login", { replace: true });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 10) {
      setError("New password must be at least 10 characters");
      return;
    }
    if (next !== confirm) {
      setError("New password and confirmation do not match");
      return;
    }
    setSubmitting(true);
    try {
      await apiPost("/change-password", { current, next });
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError((err as Error).message || "Failed to change password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-full h-full flex items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[380px]">
        <h1 className="font-display font-bold tracking-[0.22em] text-text text-[28px] leading-none">
          SET NEW PASSWORD
        </h1>
        <p className="mt-2 text-textMuted text-[13px]">
          You must change your password before continuing.
        </p>

        <form
          onSubmit={onSubmit}
          className="mt-8 border border-border bg-panel p-5 space-y-3"
        >
          <Input
            label="Current password"
            name="current"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Input
            label="New password"
            name="next"
            type="password"
            autoComplete="new-password"
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
            hint="Minimum 10 characters"
          />
          <Input
            label="Confirm new password"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />

          {error && (
            <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
              {error}
            </div>
          )}

          <Button
            variant="primary"
            type="submit"
            disabled={submitting || !current || !next || !confirm}
            className="w-full"
          >
            {submitting ? "Saving…" : "Set password"}
          </Button>
        </form>
      </div>
    </div>
  );
}