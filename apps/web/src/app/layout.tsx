// apps/web/src/app/layout.tsx
import './globals.css';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { ToastProvider } from '@/components/toast';
import { THEME_INIT_SCRIPT } from '@/components/theme';

export const metadata: Metadata = { title: 'ReelQueue', description: 'Bulk upload, schedule and auto-publish Reels through the official Instagram API.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-bg font-sans text-ink antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
