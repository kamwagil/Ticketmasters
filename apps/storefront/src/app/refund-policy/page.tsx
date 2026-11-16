import type { Metadata } from 'next';
import { PolicyPage } from '@/components/policy';

export const metadata: Metadata = { title: 'Refund policy' };

export default function Page() {
  return <PolicyPage type="REFUND" title="Refund policy" />;
}
