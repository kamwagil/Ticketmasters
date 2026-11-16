import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { buildOpenApi, configureApp } from './bootstrap';
import { config } from './common/config';
import { log } from './common/context';
import { QueueService } from './common/infra';
import { SCHEDULES } from './modules/ops/schedules';

async function main() {
  // rawBody keeps the exact bytes of webhook requests for signature verification.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: ['error', 'warn'] });
  configureApp(app);
  SwaggerModule.setup('docs', app, buildOpenApi(app), { jsonDocumentUrl: 'docs/openapi.json' });
  if (config.runWorkers) await app.get(QueueService).start(SCHEDULES);
  await app.listen(config.port);
  log.info('api_started', { port: config.port, env: config.env, workers: config.runWorkers, queueMode: config.queueMode });
}

main().catch((e) => {
  log.error('api_boot_failed', { error: e?.message, stack: e?.stack });
  process.exit(1);
});
