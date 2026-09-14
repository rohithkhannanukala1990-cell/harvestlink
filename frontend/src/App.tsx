/**
 * Route guards and app router for Harvestlink.
 * Requires JWT for app pages; role-checks settlement/settings for admins.
 */
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import type { Role } from "./api/types.ts";
import { useAuth } from "./auth/AuthContext.tsx";
import { AppLayout } from "./components/AppLayout.tsx";
import { DashboardPage } from "./pages/Dashboard.tsx";
import { InventoryPage } from "./pages/Inventory.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { MembersPage } from "./pages/Members.tsx";
import { NetworkOverviewPage } from "./pages/NetworkOverview.tsx";
import { POSPage } from "./pages/POS.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { SettlementPage } from "./pages/Settlement.tsx";

function RequireAuth() {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function RequireRoles({ roles }: { roles: Role[] }) {
  const { isRole } = useAuth();
  if (!isRole(...roles)) return <Navigate to="/" replace />;
  return <Outlet />;
}

/**
 * Root React router for Harvestlink — wires pages to backend-backed views.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="pos" element={<POSPage />} />
          <Route path="inventory" element={<InventoryPage />} />
          <Route path="members" element={<MembersPage />} />
          <Route element={<RequireRoles roles={["COOP_ADMIN"]} />}>
            <Route path="network" element={<NetworkOverviewPage />} />
          </Route>
          <Route element={<RequireRoles roles={["STORE_ADMIN", "COOP_ADMIN"]} />}>
            <Route path="settlement" element={<SettlementPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
