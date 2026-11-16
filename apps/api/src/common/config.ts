import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
const opt = (name: string, fallback = '') => process.env[name] ?? fallback;

export const config = {
  env: opt('NODE_ENV', 'development'),
  isProd: opt('NODE_ENV') === 'production',
  isTest: opt('NODE_ENV') === 'test',
  port: Number(opt('PORT', '4000')),
  apiPublicUrl: opt('API_PUBLIC_URL', 'http://localhost:4000').replace(/\/$/, ''),
  adminOrigin: opt('ADMIN_ORIGIN', 'http://localhost:3000'),
  databaseUrl: req('DATABASE_URL'),
  redisUrl: opt('REDIS_URL', 'redis://localhost:6390'),
  jwtAccessSecret: req('JWT_ACCESS_SECRET'),
  jwtCustomerSecret: req('JWT_CUSTOMER_SECRET'),
  dataEncryptionKey: req('DATA_ENCRYPTION_KEY'),
  queueMode: opt('QUEUE_MODE', 'bullmq') as 'bullmq' | 'inline',
  runWorkers: opt('RUN_WORKERS', 'true') === 'true',
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlSec: 12 * 60 * 60,
  customerTokenTtlSec: 7 * 24 * 60 * 60,
  smtp: {
    host: opt('SMTP_HOST', 'localhost'),
    port: Number(opt('SMTP_PORT', '1026')),
    secure: opt('SMTP_SECURE', 'false') === 'true',
    user: opt('SMTP_USER'),
    pass: opt('SMTP_PASS'),
  },
  sms: { username: opt('AT_USERNAME'), apiKey: opt('AT_API_KEY'), senderId: opt('AT_SENDER_ID') },
  whatsapp: { phoneNumberId: opt('WHATSAPP_PHONE_NUMBER_ID'), accessToken: opt('WHATSAPP_ACCESS_TOKEN') },
  storage: {
    driver: opt('STORAGE_DRIVER', 'local') as 'local' | 's3',
    endpoint: opt('S3_ENDPOINT'),
    region: opt('S3_REGION', 'us-east-1'),
    bucket: opt('S3_BUCKET', 'ctp-media'),
    accessKey: opt('S3_ACCESS_KEY'),
    secretKey: opt('S3_SECRET_KEY'),
    publicUrl: opt('S3_PUBLIC_URL'),
  },
  allowSandboxProvider: opt('ALLOW_SANDBOX_PROVIDER', 'false') === 'true',
};

if (config.isProd) {
  for (const k of ['JWT_ACCESS_SECRET', 'JWT_CUSTOMER_SECRET', 'DATA_ENCRYPTION_KEY']) {
    if ((process.env[k] ?? '').startsWith('dev_only') || (process.env[k] ?? '').length < 32) {
      throw new Error(`${k} must be a strong, non-default secret in production`);
    }
  }
}
