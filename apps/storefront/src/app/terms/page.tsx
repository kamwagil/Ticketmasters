import type { Metadata } from 'next';
import { PolicyPage } from '@/components/policy';

export const metadata: Metadata = { title: 'Terms and conditions' };

export default function Page() {
  return <PolicyPage type="TERMS" title="Terms and conditions" />;
}
