import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './common/config';
import { log } from './common/context';
import { QueueService } from './common/infra';
import { SCHEDULES } from './modules/ops/schedules';

/**
 * Dedicated background worker: processes queues and scheduled jobs, serves no HTTP.
 * Run any number of these next to API replicas started with RUN_WORKERS=false.
 */
async function main() {
  if (config.queueMode !== 'bullmq') throw new Error('The worker requires QUEUE_MODE=bullmq');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  await app.get(QueueService).start(SCHEDULES);
  log.info('worker_started', { env: config.env, schedules: SCHEDULES.map((s) => s.queue) });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info('worker_stopping', { signal });
    // Force exit if in-flight jobs do not finish in time; they are retried by another worker.
    const timer = setTimeout(() => process.exit(1), 30_000);
    timer.unref();
    try {
      await app.close(); // QueueService.onModuleDestroy lets running jobs finish, then closes connections
      log.info('worker_stopped', { signal });
      process.exit(0);
    } catch (e) {
      log.error('worker_shutdown_failed', { error: (e as Error).message });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('worker_boot_failed', { error: e?.message, stack: e?.stack });
  process.exit(1);
});
