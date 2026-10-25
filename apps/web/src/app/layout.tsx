import './globals.css';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { ToastProvider } from '@/components/toast';
import { THEME_INIT_SCRIPT } from '@/components/theme';

<meta name="google-site-verification" content="YxTr0DP63YCplb-BpU7xsHhJJYSZVuL6WECQ2WpKYA0" />
export const metadata: Metadata = {
  title: 'ReelQueue',
  description:
    'Bulk upload, schedule and auto-publish Reels through the official Instagram API.',
  verification: {
    // google: 'TfU4SAB73tGhNXMQ5JQKa_lcrboVEIWzXp0z5UPTvCw',
    google: 'YxTr0DP63YCplb-BpU7xsHhJJYSZVuL6WECQ2WpKYA0'
  },
};

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
