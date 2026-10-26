// apps/web/src/app/\(app\)/layout.tsx
'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { call, setUnauthenticatedHandler } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { POLL_MS, useApi } from '@/lib/use-api';
import { Button, Notice, SkeletonBlock } from '@/components/ui';
import { ThemeToggle } from '@/components/theme';
import Image from 'next/image';

const NAV = [
  ['/dashboard', 'Dashboard'], ['/uploads', 'Upload'], ['/videos', 'Videos'], ['/cycles', 'Cycles'],
  ['/jobs', 'Jobs'], ['/accounts', 'Accounts'], ['/settings', 'Settings'], ['/storage', 'Storage']
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

  // if (!me.data) return <div className="mx-auto max-w-5xl p-6"><SkeletonBlock label="Loading your session" /></div>;

  function SessionLoading() {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-orange-500/10">
            <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-orange-500/20 border-t-orange-500" />
          </div>

          <h2 className="text-xl font-semibold tracking-tight">
            Checking your session
          </h2>

          <p className="mt-2 text-sm text-muted">
            Securely connecting to your ReelQueue workspace...
          </p>

          <div className="mx-auto mt-6 h-1.5 w-40 overflow-hidden rounded-full bg-sunken">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-orange-500" />
          </div>
        </div>
      </div>
    );
  }


    if (!me.data && me.isLoading) {
    return <SessionLoading />;
  }

  if (!me.data && me.error) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
        <section className="w-full max-w-md rounded-3xl border border-line bg-bg p-7 shadow-xl sm:p-9">
          <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-500/10">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="h-7 w-7 text-orange-500"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path
                d="M12 8v5m0 3h.01"
                strokeLinecap="round"
              />
            </svg>
          </div>

          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-500">
            Session status
          </p>

          <h2 className="mt-3 text-2xl font-bold tracking-tight">
            We couldn&apos;t load your workspace
          </h2>

          <p className="mt-3 text-sm leading-6 text-muted">
            Your session may have expired, or we couldn&apos;t reach the
            server. Try again or sign in to continue.
          </p>

          <div className="mt-5 rounded-xl border border-line bg-sunken/50 p-3 text-sm">
            <p className="font-medium">Details</p>
            <p className="mt-1 break-words text-muted">
              {errorMessage(me.error)}
            </p>
          </div>

          <div className="mt-6 flex flex-col gap-3">
            <Button
              variant="primary"
              onClick={() => void me.reload()}
            >
              Try again
            </Button>

            <Button
              variant="ghost"
              onClick={() => router.replace('/login')}
            >
              Back to sign in
            </Button>
          </div>

          <p className="mt-6 text-center text-xs text-muted">
            ReelQueue · Your publishing workspace
          </p>
        </section>
      </div>
    );
  }

  if (!me.data) {
    return <SessionLoading />;
  }


  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-4 md:flex-row">
      <nav aria-label="Main" className="md:w-48 md:shrink-0">
        {/* <p className="mb-3 font-display text-2xl">ReelQueue</p> */}
        <Link href="/" aria-label="ReelQueue home" className="inline-flex items-center">
            <Image
              src="/reelqueue-logo.svg"
              alt="ReelQueue"
              width={240}
              height={56}
              priority
              className="h-auto w-48 sm:w-56"
            />
        </Link>
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
