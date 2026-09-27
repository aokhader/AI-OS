import { Navigate, NavLink, Route, Routes } from 'react-router';
import { useEscalations, useLiveUpdates } from './api';
import { Empty } from './components/ui';
import { CapabilitiesPage } from './pages/CapabilitiesPage';
import { CapabilityPage } from './pages/CapabilityPage';
import { EscalationPage } from './pages/EscalationPage';
import { EscalationsPage } from './pages/EscalationsPage';
import { RunPage } from './pages/RunPage';
import { RunsPage } from './pages/RunsPage';

/**
 * Operator console: context plus controls; the headed browser is where an operator works
 * (docs/context/03-ui-context.md). Runs and capabilities since P3, escalations since P6.
 */
const NAV = [
  { to: '/runs', label: 'Runs' },
  { to: '/capabilities', label: 'Capabilities' },
  { to: '/escalations', label: 'Escalations' },
];

function OpenCount() {
  const q = useEscalations();
  const open = q.data?.filter((i) => i.open).length ?? 0;
  if (open === 0) return null;
  return (
    <span className="ml-1 rounded-full bg-sky-600 px-1.5 text-[11px] font-semibold text-white">
      {open}
      <span className="sr-only"> open escalation(s)</span>
    </span>
  );
}

export function App() {
  useLiveUpdates();
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
                {item.to === '/escalations' ? <OpenCount /> : null}
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
          <Route path="/escalations/:id" element={<EscalationPage />} />
          <Route path="*" element={<Empty>Nothing here.</Empty>} />
        </Routes>
      </main>
    </div>
  );
}
