import { Navigate, NavLink, Route, Routes } from 'react-router';
import { Empty, PageTitle } from './components/ui';
import { CapabilitiesPage } from './pages/CapabilitiesPage';
import { CapabilityPage } from './pages/CapabilityPage';
import { RunPage } from './pages/RunPage';
import { RunsPage } from './pages/RunsPage';

/**
 * Operator console: context plus controls; the headed browser is where an operator works
 * (docs/context/03-ui-context.md). P3 ships runs and capabilities; escalations follow in P6.
 */
const NAV = [
  { to: '/runs', label: 'Runs' },
  { to: '/capabilities', label: 'Capabilities' },
  { to: '/escalations', label: 'Escalations' },
];

function EscalationsPage() {
  return (
    <>
      <PageTitle>Escalations</PageTitle>
      <Empty>The inbox, claim and hand-back controls arrive in phase P6.</Empty>
    </>
  );
}

export function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <NavLink to="/runs" className="text-base font-semibold tracking-tight">
            HandsOff
          </NavLink>
          <nav className="flex gap-1 text-sm" aria-label="Main">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `rounded px-2 py-1 ${isActive ? 'bg-neutral-900 text-white' : 'text-neutral-700 hover:bg-neutral-100'}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/runs" replace />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/capabilities" element={<CapabilitiesPage />} />
          <Route path="/capabilities/:id" element={<CapabilityPage />} />
          <Route path="/capabilities/:id/v/:version" element={<CapabilityPage />} />
          <Route path="/escalations" element={<EscalationsPage />} />
          <Route path="*" element={<Empty>Nothing here.</Empty>} />
        </Routes>
      </main>
    </div>
  );
}
