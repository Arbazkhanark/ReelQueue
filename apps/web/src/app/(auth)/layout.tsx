// apps/web/src/app/\(auth\)/layout.tsx
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      {/* <h1 className="mb-6 font-display text-3xl">ReelQueue</h1> */}
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
      <div className="card p-6">{children}</div>
    </main>
  );
}
