import { lazy, Suspense, type ReactNode } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AppShell } from "./components/shell/AppShell";
import { HomePage } from "./pages/Home";
import { PageSkeleton } from "./components/ui/feedback/PageSkeleton";

// ── Lazy page chunks ─────────────────────────────────────────────────
// Each page is split into its own chunk so the initial bundle only
// ships the shell + login + setup. Subsequent routes load on demand.
// The lazy wrapper maps each module's named export to `default` so the
// chunk can be rendered with <Route element={<XPage />}>.
const LoginPage = lazy(() =>
  import("./pages/Login").then((m) => ({ default: m.LoginPage })),
);
const ChangePasswordPage = lazy(() =>
  import("./pages/ChangePassword").then((m) => ({
    default: m.ChangePasswordPage,
  })),
);
const ChatPage = lazy(() =>
  import("./pages/Chat").then((m) => ({ default: m.ChatPage })),
);
const PanelsPage = lazy(() =>
  import("./pages/Panels").then((m) => ({ default: m.PanelsPage })),
);
const WebSearchPage = lazy(() =>
  import("./pages/WebSearch").then((m) => ({ default: m.WebSearchPage })),
);
const WorkspacePage = lazy(() =>
  import("./pages/Workspace").then((m) => ({ default: m.WorkspacePage })),
);
const SandboxPage = lazy(() =>
  import("./pages/Sandbox").then((m) => ({ default: m.SandboxPage })),
);
const WatchesPage = lazy(() =>
  import("./pages/Watches").then((m) => ({ default: m.WatchesPage })),
);
const AnalyticsPage = lazy(() =>
  import("./pages/Analytics").then((m) => ({ default: m.AnalyticsPage })),
);
const RequestsPage = lazy(() =>
  import("./pages/Requests").then((m) => ({ default: m.RequestsPage })),
);
const ProvidersPage = lazy(() =>
  import("./pages/Providers").then((m) => ({ default: m.ProvidersPage })),
);
const IntegrationsPage = lazy(() =>
  import("./pages/Integrations").then((m) => ({
    default: m.IntegrationsPage,
  })),
);
const MemoryStrategiesPage = lazy(() =>
  import("./pages/MemoryStrategies").then((m) => ({
    default: m.MemoryStrategiesPage,
  })),
);
const ConnectedAccountsPage = lazy(() =>
  import("./pages/ConnectedAccounts").then((m) => ({
    default: m.ConnectedAccountsPage,
  })),
);
const SettingsPage = lazy(() =>
  import("./pages/Settings").then((m) => ({ default: m.SettingsPage })),
);
const AppsPage = lazy(() =>
  import("./pages/Apps").then((m) => ({ default: m.AppsPage })),
);
const SkillsPage = lazy(() =>
  import("./pages/Skills").then((m) => ({ default: m.SkillsPage })),
);
const FeedbackPage = lazy(() =>
  import("./pages/Feedback").then((m) => ({ default: m.FeedbackPage })),
);
const MarketplacePage = lazy(() =>
  import("./pages/Marketplace").then((m) => ({ default: m.MarketplacePage })),
);
const SearchPage = lazy(() =>
  import("./pages/Search").then((m) => ({ default: m.SearchPage })),
);
const KnowledgeGraphPage = lazy(() =>
  import("./pages/KnowledgeGraph").then((m) => ({
    default: m.KnowledgeGraphPage,
  })),
);
const WorkflowsPage = lazy(() =>
  import("./pages/Workflows").then((m) => ({ default: m.WorkflowsPage })),
);
const WorkflowEditorPage = lazy(() =>
  import("./pages/Workflows").then((m) => ({
    default: m.WorkflowEditorPage,
  })),
);
const ApprovalsPage = lazy(() =>
  import("./pages/Approvals").then((m) => ({ default: m.ApprovalsPage })),
);
const ReplayPage = lazy(() =>
  import("./components/system/ReplayBar").then((m) => ({
    default: m.ReplayPage,
  })),
);
const SetupPage = lazy(() =>
  import("./pages/Setup").then((m) => ({ default: m.SetupPage })),
);
const StatusPage = lazy(() =>
  import("./pages/Status").then((m) => ({ default: m.StatusPage })),
);
const SpendCapsPage = lazy(() =>
  import("./pages/SpendCaps").then((m) => ({ default: m.SpendCapsPage })),
);
const HealthPage = lazy(() =>
  import("./pages/Health").then((m) => ({ default: m.HealthPage })),
);
const PerfPage = lazy(() =>
  import("./pages/Perf").then((m) => ({ default: m.PerfPage })),
);

import { NAV_ITEMS } from "./nav/items";
import { ToastProvider } from "./components/ui/feedback/Toast";
import {
  CommandPaletteProvider,
} from "./components/system/CommandPalette";
import { CmdKListener } from "./components/system/CommandKListener";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="mono-caps text-[11px] text-textFaint">booting…</div>
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="mono-caps text-[11px] text-textFaint">booting…</div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") {
    return (
      <div className="p-6">
        <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-3 py-2 inline-block">
          403 · admin only
        </div>
        <p className="mt-3 text-textMuted text-[13px]">
          Your account doesn't have access to this section.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

function NavRoute({ path }: { path: string }) {
  const item = NAV_ITEMS.find((i) => i.path === path);
  if (!item) return <HomePage />;
  switch (item.path) {
    case "/chat":
      return <ChatPage />;
    case "/panels":
      return <PanelsPage />;
    case "/workspace":
      return <WorkspacePage />;
    case "/sandbox":
      return <SandboxPage />;
    case "/watches":
      return <WatchesPage />;
    case "/workflows":
      return <WorkflowsPage />;
    case "/web-search":
      return <WebSearchPage />;
    case "/analytics":
      return <AnalyticsPage />;
    case "/requests":
      return <RequestsPage />;
    case "/providers":
      return <ProvidersPage />;
    case "/integrations":
      return <IntegrationsPage />;
    case "/memory-strategies":
      return <MemoryStrategiesPage />;
    case "/connected-accounts":
      return <ConnectedAccountsPage />;
    case "/apps":
      return <AppsPage />;
    case "/skills":
      return <SkillsPage />;
    case "/feedback":
      return <FeedbackPage />;
    case "/approvals":
      return <ApprovalsPage />;
    case "/status":
      return <StatusPage />;
    case "/spend-caps":
      return <SpendCapsPage />;
    case "/perf":
      return <PerfPage />;
    case "/health":
      return <HealthPage />;
    // Tier 4 — Discovery
    case "/marketplace":
      return <MarketplacePage />;
    case "/search":
      return <SearchPage />;
    case "/kg":
      return <KnowledgeGraphPage />;
    case "/settings":
      return <SettingsPage />;
    default:
      return <HomePage />;
  }
}

function ShellRoutes() {
  return (
    <AppShell>
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          {NAV_ITEMS.map((item) => (
            <Route
              key={item.path}
              path={item.path}
              element={
                item.adminOnly ? (
                  <RequireAdmin>
                    <NavRoute path={item.path} />
                  </RequireAdmin>
                ) : (
                  <NavRoute path={item.path} />
                )
              }
            />
          ))}
          {/* Tier 1 co-pilot — time-travel replay viewer. Param-driven
              so a deep link from /panels opens straight into a panel's
              snapshot timeline. */}
          <Route path="/replay/:panelId" element={<ReplayPage />} />
          {/* Tier 2 — visual workflow canvas editor. */}
          <Route path="/workflows/:id" element={<WorkflowEditorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

export function App() {
  // Order matters: BrowserRouter must wrap the providers whose components
  // need router context (CommandPalette calls useNavigate inside its portal,
  // and WorkspaceHeader's search trigger navigates as well).
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <CommandPaletteProvider>
            <Suspense fallback={<PageSkeleton />}>
              <Routes>
                {/* Tier 7 — onboarding wizard. The page itself probes
                    /api/setup/status and redirects to /login if the
                    system is already configured. */}
                <Route path="/setup" element={<SetupPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route
                  path="/change-password"
                  element={
                    <RequireAuth>
                      <ChangePasswordPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/*"
                  element={
                    <RequireAuth>
                      <ShellRoutes />
                    </RequireAuth>
                  }
                />
              </Routes>
            </Suspense>
            <CmdKListener />
          </CommandPaletteProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
