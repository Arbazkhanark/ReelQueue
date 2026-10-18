'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { call, setUnauthenticatedHandler } from '@/lib/api';
import { POLL_MS, useApi } from '@/lib/use-api';
import { Button, Notice, SkeletonBlock } from '@/components/ui';
import { ThemeToggle } from '@/components/theme';

const NAV = [
  ['/dashboard', 'Dashboard'], ['/uploads', 'Upload'], ['/videos', 'Videos'], ['/cycles', 'Cycles'],
  ['/jobs', 'Jobs'], ['/accounts', 'Accounts'], ['/settings', 'Settings'],
] as const;

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    setUnauthenticatedHandler(() => router.replace(`/login?next=${encodeURIComponent(path || '/dashboard')}`));
    return () => setUnauthenticatedHandler(undefined);
  }, [router, path]);

  const me = useApi('me');
  const dash = useApi('dashboard', { refreshMs: POLL_MS, enabled: !!me.data });

  async function logout() {
    try { await call('logout', { noAuthRedirect: true }); } catch { /* the cookie is cleared server-side; navigate anyway */ }
    router.replace('/login');
  }

  if (!me.data) return <div className="mx-auto max-w-5xl p-6"><SkeletonBlock label="Loading your session" /></div>;

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-4 md:flex-row">
      <nav aria-label="Main" className="md:w-48 md:shrink-0">
        <p className="mb-3 font-display text-2xl">ReelQueue</p>
        <ul className="flex flex-wrap gap-1 md:flex-col">
          {NAV.map(([href, label]) => (
            <li key={href}>
              <Link href={href} aria-current={path === href ? 'page' : undefined} className={`block rounded-md px-3 py-1.5 text-sm ${path === href ? 'bg-sunken font-semibold' : 'hover:bg-sunken'}`}>{label}</Link>
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-2 text-xs text-muted">
          <p className="break-all">{me.data.email}</p>
          <div className="flex items-center gap-2"><ThemeToggle /><Button small variant="ghost" onClick={() => void logout()}>Sign out</Button></div>
        </div>
      </nav>
      <main className="min-w-0 flex-1">
        {dash.data?.mockMode ? (
          <div className="mb-4">
            <Notice tone="sim" title="Simulation mode">Publishing is simulated. Nothing is sent to Instagram, and results are labelled “Simulated”, never “Published”.</Notice>
          </div>
        ) : null}
        {me.data.status === 'PENDING_DELETION' ? <div className="mb-4"><Notice tone="warn" title="Account scheduled for deletion">Cancel it in Settings to keep your data.</Notice></div> : null}
        {children}
      </main>
    </div>
  );
}
