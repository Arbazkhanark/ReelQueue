import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <h1 className="mb-6 font-display text-3xl">ReelQueue</h1>
      <div className="card p-6">{children}</div>
    </main>
  );
}
