import type { Metadata } from 'next';
import { PolicyPage } from '@/components/policy';

export const metadata: Metadata = { title: 'Privacy policy' };

export default function Page() {
  return <PolicyPage type="PRIVACY" title="Privacy policy" />;
}
