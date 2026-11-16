import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { config } from './common/config';
import { requestContextMiddleware } from './common/context';
import { AllExceptionsFilter } from './common/errors';
import { LOCAL_MEDIA_DIR } from './common/storage';

/** Applies the HTTP pipeline shared by the server and the test harness. */
export function configureApp(app: INestApplication) {
  const express = app as NestExpressApplication;
  express.set('trust proxy', 1); // behind Nginx / a managed load balancer
  express.disable('x-powered-by');
  app.use(requestContextMiddleware);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors({
    // Only the admin portal calls this API from a browser. Storefronts call it server-to-server.
    origin: config.adminOrigin.split(',').map((s) => s.trim()),
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  express.useStaticAssets(LOCAL_MEDIA_DIR, { prefix: '/media/', maxAge: '365d', immutable: true, index: false, dotfiles: 'deny' });
  app.enableShutdownHooks();
}

export function buildOpenApi(app: INestApplication) {
  const doc = new DocumentBuilder()
    .setTitle('Central Ticketing Platform API')
    .setDescription(
      [
        'One API for every storefront and for the central administration portal.',
        '',
        '**Storefront API** (`/v1/storefront/*`): authenticate with the storefront secret in `X-Storefront-Key`. The brand is derived from the key. Call it from the storefront server, never from a browser. Customer-specific calls also send `X-Customer-Token`.',
        '',
        '**Admin API** (`/v1/admin/*`, `/v1/scanner/*`): `Authorization: Bearer <access token>` from `/v1/admin/auth/login`.',
        '',
        '**Money** is always integer minor units (`...Minor`) with an ISO-4217 `currency`.',
        '',
        '**Errors** are `{ "error": { "code", "message", "details?", "correlationId" } }`. `X-Request-Id` is echoed on every response.',
        '',
        '**Idempotency**: send `Idempotency-Key` on checkout and refund requests; a retry returns the original result.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Storefront-Key' }, 'storefront-key')
    .build();
  return SwaggerModule.createDocument(app, doc);
}
