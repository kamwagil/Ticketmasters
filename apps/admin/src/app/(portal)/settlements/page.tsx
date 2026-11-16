'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Notice } from '@/components/platform/bits';
import { EmptyState, PageHeader, Tabs } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { CommissionRulesTab } from './commissions';
import { GatewaySettlementsTab, ReconciliationTab } from './gateway';
import { PayablesTab, PayoutsTab } from './payouts';

export default function SettlementsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { can, user } = useAuth();
  // Payables, payouts and gateway settlements span brands, so the API reserves them for platform-wide finance staff.
  const tabs = [
    { id: 'payables', label: 'Promoter payables', show: can('settlements.read') && user.allBrands },
    { id: 'payouts', label: 'Payouts', show: can('settlements.read') && user.allBrands },
    { id: 'gateway', label: 'Gateway settlements', show: can('payments.reconcile') && user.allBrands },
    { id: 'reconciliation', label: 'Reconciliation', show: can('payments.reconcile') },
    { id: 'commissions', label: 'Commission rules', show: can('commissions.read') },
  ].filter((t) => t.show);
  const active = tabs.find((t) => t.id === params.get('tab'))?.id ?? tabs[0]?.id;

  return (
    <>
      <PageHeader title="Settlements" description="What is owed to promoters, payouts and their approvals, money settled by the gateways, reconciliation and the commission rules behind every allocation." />
      {!user.allBrands && can('settlements.read') && (
        <div className="mb-5"><Notice>Promoter payables, payouts and gateway settlements cover every brand, so they are handled by the platform finance team.</Notice></div>
      )}
      {!tabs.length ? (
        <EmptyState title="Nothing here for your role" description="Settlement tools are available to finance staff. Ask a platform administrator if you need access." />
      ) : (
        <>
          <Tabs tabs={tabs} active={active} onChange={(id) => router.replace(`/settlements?tab=${id}`)} />
          {active === 'payables' && <PayablesTab />}
          {active === 'payouts' && <PayoutsTab />}
          {active === 'gateway' && <GatewaySettlementsTab />}
          {active === 'reconciliation' && <ReconciliationTab />}
          {active === 'commissions' && <CommissionRulesTab />}
        </>
      )}
    </>
  );
}
