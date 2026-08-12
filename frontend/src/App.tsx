import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AppShell } from "./components/shell/AppShell";
import { LoginPage } from "./pages/Login";
import { ChangePasswordPage } from "./pages/ChangePassword";
import { HomePage } from "./pages/Home";
import { ChatPage } from "./pages/Chat";
import { PanelsPage } from "./pages/Panels";
import { WebSearchPage } from "./pages/WebSearch";
import { WorkspacePage } from "./pages/Workspace";
import { SandboxPage } from "./pages/Sandbox";
import { WatchesPage } from "./pages/Watches";
import { AnalyticsPage } from "./pages/Analytics";
import { RequestsPage } from "./pages/Requests";
import { ProvidersPage } from "./pages/Providers";
import { IntegrationsPage } from "./pages/Integrations";
import { MemoryStrategiesPage } from "./pages/MemoryStrategies";
import { ConnectedAccountsPage } from "./pages/ConnectedAccounts";
import { SettingsPage } from "./pages/Settings";
import { AppsPage } from "./pages/Apps";
import { SkillsPage } from "./pages/Skills";
import { FeedbackPage } from "./pages/Feedback";
// Tier 4 (Discovery): marketplace, search, knowledge graph
import { MarketplacePage } from "./pages/Marketplace";
import { SearchPage } from "./pages/Search";
import { KnowledgeGraphPage } from "./pages/KnowledgeGraph";
import { WorkflowsPage, WorkflowEditorPage } from "./pages/Workflows";
import { ApprovalsPage } from "./pages/Approvals";
import { ReplayPage } from "./components/system/ReplayBar";
import { SetupPage } from "./pages/Setup";
import { StatusPage } from "./pages/Status";
import { SpendCapsPage } from "./pages/SpendCaps";
import { HealthPage } from "./pages/Health";
import { PerfPage } from "./pages/Perf";
import type { ReactNode } from "react";
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
            <CmdKListener />
          </CommandPaletteProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}