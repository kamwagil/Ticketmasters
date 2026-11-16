'use client';

import { Suspense } from 'react';
import { AuthProvider } from '@/lib/auth';

/** The gate scanner is a full-screen app: signed-in staff only, without the portal shell. */
export default function ScanLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <AuthProvider>{children}</AuthProvider>
    </Suspense>
  );
}
