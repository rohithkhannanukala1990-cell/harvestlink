/**
 * App shell with role-aware navigation for HarvestLinx pages.
 *
 * COOP_ADMIN gets a persistent "Switch store" control so POS / Inventory / Settlement
 * hit the intended storeId after Network Overview. Multi-store switching was deferred
 * until single-store scoping was solid — easier to debug with one store first.
 */
import { Link, NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../api/client.ts";
import type { Store } from "../api/types.ts";
import { useAuth } from "../auth/AuthContext.tsx";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `inline-flex min-h-[44px] items-center rounded-md px-3 py-2 text-sm text-ink-inverse ${
    isActive
      ? "bg-brand-green font-bold underline decoration-2 underline-offset-4"
      : "font-medium text-ink-inverse/80 hover:bg-brand-green/35 hover:text-ink-inverse"
  }`;

export function AppLayout() {
  const { user, logout, activeStoreId, setStoreId, isRole } = useAuth();

  const storesQuery = useQuery({
    queryKey: ["stores"],
    queryFn: () => apiRequest<{ stores: Store[] }>("/stores"),
    enabled: !!user,
  });

  const bannerStoreId = isRole("COOP_ADMIN") ? activeStoreId : user?.storeId ?? null;

  const recallsBannerQuery = useQuery({
    queryKey: ["recalls", "active-for-store", bannerStoreId],
    queryFn: () =>
      apiRequest<{
        recalls: Array<{
          recallId: string;
          recallNumber: string;
          status: string;
          severity: string;
          reason: string;
          lotNumbers: string[];
        }>;
      }>(`/recalls/active-for-store?storeId=${encodeURIComponent(bannerStoreId!)}`),
    enabled: !!user && !!bannerStoreId,
    refetchInterval: 60_000,
  });

  const activeStoreName =
    storesQuery.data?.stores.find((s) => s.id === activeStoreId)?.name ?? null;

  const activeRecalls = recallsBannerQuery.data?.recalls ?? [];

  return (
    <div className="min-h-screen bg-surface-page text-ink">
      {/* Canopy carries ink-inverse only — never ink / muted on this field. */}
      <header className="bg-surface-canopy text-ink-inverse">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
          <Link to="/" className="text-lg font-extrabold tracking-tight text-ink-inverse">
            {/* Plain-type stand-in — replace with the real logo file when available; do not redraw the mark. */}
            <span>Harvest</span>
            <span className="text-brand-terracotta">Linx</span>
          </Link>
          <nav className="flex flex-wrap gap-1">
            {isRole("COOP_ADMIN") && (
              <NavLink to="/network" className={linkClass}>
                Network
              </NavLink>
            )}
            {isRole("COOP_ADMIN") && (
              <NavLink to="/audit" className={linkClass}>
                Audit
              </NavLink>
            )}
            {isRole("COOP_ADMIN") && (
              <NavLink to="/recalls" className={linkClass}>
                Recalls
              </NavLink>
            )}
            <NavLink to="/" end className={linkClass}>
              Dashboard
            </NavLink>
            <NavLink to="/pos" className={linkClass}>
              POS
            </NavLink>
            <NavLink to="/sales" className={linkClass}>
              Sales
            </NavLink>
            <NavLink to="/drawer" className={linkClass}>
              Drawer
            </NavLink>
            <NavLink to="/inventory" className={linkClass}>
              Inventory
            </NavLink>
            <NavLink to="/lots" className={linkClass}>
              Lots
            </NavLink>
            <NavLink to="/members" className={linkClass}>
              Members
            </NavLink>
            {isRole("STORE_ADMIN", "COOP_ADMIN") && (
              <NavLink to="/suppliers" className={linkClass}>
                Suppliers
              </NavLink>
            )}
            {isRole("STORE_ADMIN", "COOP_ADMIN") && (
              <NavLink to="/purchase-orders" className={linkClass}>
                POs
              </NavLink>
            )}
            {isRole("STORE_ADMIN", "COOP_ADMIN") && (
              <NavLink to="/settlement" className={linkClass}>
                Settlement
              </NavLink>
            )}
            {isRole("STORE_ADMIN", "COOP_ADMIN") && (
              <NavLink to="/daily-close" className={linkClass}>
                Daily close
              </NavLink>
            )}
            {isRole("STORE_ADMIN", "COOP_ADMIN") && (
              <NavLink to="/settings" className={linkClass}>
                Settings
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-sm text-ink-inverse">
            {isRole("COOP_ADMIN") && (
              <label className="flex items-center gap-2 rounded-md border border-ink-inverse/30 bg-brand-green/40 px-2 py-1">
                <span className="font-medium">Switch store</span>
                <select
                  className="rounded border border-ink-inverse/30 bg-surface-canopy px-2 py-1 text-ink-inverse"
                  value={activeStoreId ?? ""}
                  onChange={(e) => setStoreId(e.target.value)}
                  aria-label="Switch store"
                >
                  <option value="" disabled>
                    Select store
                  </option>
                  {(storesQuery.data?.stores ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {activeStoreName && (
                  <span className="hidden opacity-80 sm:inline">
                    Viewing: {activeStoreName}
                  </span>
                )}
              </label>
            )}
            <span className="text-ink-inverse/80">
              {user?.email} · {user?.role}
            </span>
            <button
              type="button"
              onClick={logout}
              className="inline-flex min-h-[44px] items-center rounded-md border border-ink-inverse/40 px-3 font-medium text-ink-inverse hover:bg-brand-green/40"
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      {/* ACTIVE recall banner — shown on every page for the affected store (Inventory, Lots, POS, receiving included). */}
      {activeRecalls.length > 0 && (
        <div
          className="border-b border-state-danger bg-state-danger text-ink-inverse"
          role="alert"
        >
          <div className="mx-auto max-w-7xl px-4 py-3 text-sm">
            <p className="font-semibold tracking-wide">ACTIVE PRODUCT RECALL</p>
            <ul className="mt-1 space-y-1">
              {activeRecalls.map((r) => (
                <li key={r.recallId}>
                  <span className="font-medium">{r.recallNumber}</span>
                  {" · "}
                  {r.severity} · {r.status} — {r.reason}
                  {r.lotNumbers.length > 0 && (
                    <span className="opacity-90"> (lots: {r.lotNumbers.join(", ")})</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1 opacity-90">
              Do not sell affected lots. Quarantined / recalled stock is blocked at POS.
            </p>
          </div>
        </div>
      )}
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
