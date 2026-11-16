// Test environment. Loaded before any application module so config.ts sees these values.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://ctp:ctp_dev_password@localhost:5544/ctp_test?schema=public&connection_limit=40';
process.env.QUEUE_MODE = 'inline';
process.env.RUN_WORKERS = 'false';
process.env.JWT_ACCESS_SECRET = 'test_access_secret_0123456789abcdef0123456789';
process.env.JWT_CUSTOMER_SECRET = 'test_customer_secret_0123456789abcdef0123456789';
process.env.DATA_ENCRYPTION_KEY = 'test_data_encryption_key_0123456789abcdef';
process.env.API_PUBLIC_URL = 'http://api.test';
process.env.ALLOW_SANDBOX_PROVIDER = 'true';
process.env.SMTP_HOST = process.env.SMTP_HOST ?? 'localhost';
process.env.SMTP_PORT = process.env.SMTP_PORT ?? '1026';
process.env.STORAGE_DRIVER = 'local';
