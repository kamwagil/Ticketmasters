import { execSync } from 'child_process';
import * as path from 'path';

/** Creates/migrates the dedicated test database once per test run. */
export default async function globalSetup() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./env');
  const cwd = path.resolve(__dirname, '..');
  execSync('npx prisma migrate deploy', { cwd, env: process.env, stdio: 'pipe' });
  // Test data is disposable: skip the fsync on every COMMIT so the suite is not bound by disk latency.
  const db = new URL(process.env.DATABASE_URL as string).pathname.slice(1);
  execSync('npx prisma db execute --stdin --url "' + process.env.DATABASE_URL + '"', { cwd, env: process.env, stdio: 'pipe', input: `ALTER DATABASE "${db}" SET synchronous_commit = off;` });
}
