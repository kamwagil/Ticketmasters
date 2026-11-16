'use client';

import { Suspense } from 'react';
import { Shell } from '@/components/shell';
import { AuthProvider } from '@/lib/auth';

/** Everything under (portal) requires a signed-in staff member and renders inside the app shell. */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <AuthProvider>
        <Shell>
          <Suspense>{children}</Suspense>
        </Shell>
      </AuthProvider>
    </Suspense>
  );
}
