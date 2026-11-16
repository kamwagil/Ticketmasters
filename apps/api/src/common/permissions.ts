/**
 * Permission catalogue and the default role → permission mapping used by the seed.
 * At runtime, roles and their permissions are read from the database, so operators can
 * create roles and re-assign permissions without a deploy.
 */
export const PERMISSIONS: Record<string, string> = {
  'brands.read': 'View brand configuration',
  'brands.manage': 'Create and edit brands, domains, policies and storefront keys',
  'brands.payment_config': 'Manage brand payment configurations and merchant accounts',
  'events.read': 'View events, venues and performers',
  'events.manage': 'Create and edit events, venues, performers and ticket categories',
  'events.publish': 'Publish, unpublish and cancel events',
  'inventory.read': 'View inventory levels and movements',
  'inventory.manage': 'Adjust inventory and run reconciliation',
  'orders.read': 'View orders',
  'orders.manage': 'Cancel orders and resend tickets',
  'orders.export': 'Export orders',
  'payments.read': 'View payments and webhook events',
  'payments.reconcile': 'Run reconciliation and record gateway settlements',
  'refunds.read': 'View refunds',
  'refunds.request': 'Create refund requests',
  'refunds.approve': 'Approve or reject refund requests',
  'refunds.self_approve': 'Approve refund requests you created yourself',
  'tickets.read': 'View tickets and scan history',
  'tickets.manage': 'Revoke and reissue tickets',
  'tickets.scan': 'Scan and validate tickets',
  'customers.read': 'View customers',
  'customers.manage': 'Edit customers, notes and tags',
  'customers.privacy': 'Handle data access, correction and deletion requests',
  'crm.segments': 'Create and evaluate customer segments',
  'marketing.read': 'View campaigns and promo codes',
  'marketing.manage': 'Create and send campaigns, manage promo codes',
  'organizers.read': 'View sellers and promoters',
  'organizers.manage': 'Manage sellers and promoters',
  'commissions.read': 'View commission rules',
  'commissions.manage': 'Manage commission rules',
  'settlements.read': 'View promoter payables and payouts',
  'settlements.manage': 'Create payouts and mark them paid',
  'payouts.approve': 'Approve promoter payouts',
  'support.read': 'View support tickets',
  'support.manage': 'Reply to, assign and resolve support tickets',
  'reports.read': 'View operational reports',
  'reports.financial': 'View financial reports and the ledger',
  'reports.export': 'Export reports to CSV and Excel',
  'staff.read': 'View staff accounts',
  'staff.manage': 'Create and edit staff accounts and assignments',
  'roles.manage': 'Create roles and change role permissions',
  'integrations.read': 'View integrations and integration logs',
  'integrations.manage': 'Configure integrations and notification templates',
  'audit.read': 'View audit logs',
  'settings.manage': 'Change platform settings, currencies and exchange rates',
  'system.health': 'View system health and alerts',
};

export type PermissionKey = keyof typeof PERMISSIONS;
const all = Object.keys(PERMISSIONS);

export const DEFAULT_ROLES: { key: string; name: string; description: string; eventScoped?: boolean; permissions: string[] }[] = [
  { key: 'super_admin', name: 'Super Administrator', description: 'Full platform access across all brands', permissions: all },
  {
    key: 'brand_admin',
    name: 'Brand Administrator',
    description: 'Manages the assigned brand(s)',
    permissions: all.filter(
      (p) =>
        !['brands.payment_config', 'roles.manage', 'settings.manage', 'system.health', 'integrations.manage', 'commissions.manage',
          'payouts.approve', 'settlements.manage', 'payments.reconcile', 'organizers.manage', 'refunds.self_approve'].includes(p),
    ),
  },
  {
    key: 'finance_officer',
    name: 'Finance Officer',
    description: 'Reconciliation, refunds, commissions and financial reporting',
    permissions: ['orders.read', 'orders.export', 'payments.read', 'payments.reconcile', 'refunds.read', 'refunds.request', 'refunds.approve',
      'commissions.read', 'settlements.read', 'settlements.manage', 'payouts.approve', 'organizers.read', 'reports.read', 'reports.financial',
      'reports.export', 'events.read', 'brands.read', 'customers.read'],
  },
  {
    key: 'event_manager',
    name: 'Event Manager',
    description: 'Manages assigned events, ticket categories and inventory',
    eventScoped: true,
    permissions: ['events.read', 'events.manage', 'events.publish', 'inventory.read', 'inventory.manage', 'orders.read', 'tickets.read',
      'reports.read', 'brands.read', 'organizers.read'],
  },
  {
    key: 'customer_support',
    name: 'Customer Support',
    description: 'Handles customer enquiries, resends tickets and escalates refunds',
    permissions: ['customers.read', 'orders.read', 'orders.manage', 'tickets.read', 'payments.read', 'refunds.read', 'refunds.request',
      'support.read', 'support.manage', 'events.read', 'brands.read'],
  },
  {
    key: 'marketing_manager',
    name: 'Marketing Manager',
    description: 'Campaigns, segments and promotional codes',
    permissions: ['customers.read', 'crm.segments', 'marketing.read', 'marketing.manage', 'events.read', 'reports.read', 'brands.read'],
  },
  {
    key: 'ticket_scanner',
    name: 'Ticket Scanner',
    description: 'Scans tickets at assigned events',
    eventScoped: true,
    permissions: ['tickets.scan'],
  },
];
