/**
 * Repeatable background schedules. They are BullMQ job schedulers, so however many worker
 * replicas run, each tick is executed by exactly one of them.
 */
export const SCHEDULES: { queue: string; everyMs: number }[] = [
  { queue: 'maint-expire-orders', everyMs: 30_000 },
  { queue: 'notification-sweep', everyMs: 30_000 },
  { queue: 'maint-payments', everyMs: 60_000 },
  { queue: 'maint-lifecycle', everyMs: 60_000 },
  { queue: 'maint-health', everyMs: 5 * 60_000 },
];
