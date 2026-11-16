/**
 * Production entry point for reference data: permissions, system roles, currencies, payment
 * providers and default notification templates. Idempotent; run on every deploy after migrations.
 * It never creates demo brands, users or events.
 *
 * To create the first Super Administrator, set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD
 * for one run; the account is created only if no platform-wide user exists yet.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from './common/crypto';
import { DEFAULT_ROLES, PERMISSIONS } from './common/permissions';
import { DEFAULT_TEMPLATES } from './modules/notifications/templates';

async function main() {
  const prisma = new PrismaClient();
  try {
    for (const [key, description] of Object.entries(PERMISSIONS)) {
      const group = key.split('.')[0];
      await prisma.permission.upsert({ where: { key }, create: { key, description, group }, update: { description, group } });
    }
    const perms = await prisma.permission.findMany();
    for (const r of DEFAULT_ROLES) {
      const existing = await prisma.role.findUnique({ where: { key: r.key } });
      if (!existing) {
        await prisma.role.create({
          data: {
            key: r.key, name: r.name, description: r.description, isSystem: true, eventScoped: r.eventScoped ?? false,
            permissions: { create: perms.filter((p) => r.permissions.includes(p.key)).map((p) => ({ permissionId: p.id })) },
          },
        });
      } else if (r.key === 'super_admin') {
        await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: existing.id, permissionId: p.id })), skipDuplicates: true });
      }
    }
    const currencies: [string, string][] = [['KES', 'Kenyan Shilling'], ['USD', 'US Dollar'], ['GBP', 'Pound Sterling'], ['EUR', 'Euro'], ['UGX', 'Ugandan Shilling'], ['TZS', 'Tanzanian Shilling'], ['NGN', 'Nigerian Naira'], ['ZAR', 'South African Rand']];
    for (const [code, name] of currencies) await prisma.currency.upsert({ where: { code }, create: { code, name }, update: {} });
    const providers: [string, string, boolean][] = [['paystack', 'Paystack', false], ['flutterwave', 'Flutterwave', false], ['sandbox', 'Sandbox (test only)', true]];
    for (const [code, name, isTestOnly] of providers) await prisma.paymentProvider.upsert({ where: { code }, create: { code, name, isTestOnly, enabled: !isTestOnly }, update: { name, isTestOnly } });
    for (const [type, t] of Object.entries(DEFAULT_TEMPLATES)) {
      await prisma.emailTemplate.upsert({ where: { type_channel: { type, channel: 'EMAIL' } }, create: { type, channel: 'EMAIL', subject: t.subject, bodyHtml: t.bodyHtml }, update: {} });
      if (t.sms) await prisma.emailTemplate.upsert({ where: { type_channel: { type, channel: 'SMS' } }, create: { type, channel: 'SMS', subject: type, bodyHtml: t.sms, bodyText: t.sms }, update: {} });
    }

    const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (email && password) {
      if (password.length < 14) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 14 characters');
      if (!(await prisma.user.count({ where: { allBrands: true, deletedAt: null } }))) {
        const role = await prisma.role.findUniqueOrThrow({ where: { key: 'super_admin' } });
        await prisma.user.create({ data: { email, fullName: 'Platform Administrator', passwordHash: await hashPassword(password), allBrands: true, roles: { create: { roleId: role.id } } } });
        console.log(`Created the first Super Administrator: ${email}. Sign in, enable two-step verification, and remove the BOOTSTRAP_ADMIN_* variables.`);
      }
    }
    console.log('Reference data is up to date.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
