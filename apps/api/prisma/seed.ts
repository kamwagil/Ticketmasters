/**
 * Seed data.
 *  - seedBase(): reference data every environment needs (permissions, system roles,
 *    currencies, payment providers, default notification templates). Idempotent.
 *  - seedDemo(): five demonstration storefront brands, staff, events and inventory.
 *    Development only. Demo orders are created separately by `npm run db:demo-orders`,
 *    which drives the real checkout and payment code.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { encryptJson, hashPassword, sha256 } from '../src/common/crypto';
import { DEFAULT_ROLES, PERMISSIONS } from '../src/common/permissions';
import { DEFAULT_TEMPLATES } from '../src/modules/notifications/templates';

export const DEMO_PASSWORD = 'ChangeMe!Dev2026';
export const demoStorefrontKey = (slug: string) => `sfk_dev_${slug}_local_only_do_not_use_in_production`;

export async function seedBase(prisma: PrismaClient) {
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, create: { key, description, group: key.split('.')[0] }, update: { description, group: key.split('.')[0] } });
  }
  const perms = await prisma.permission.findMany();
  for (const r of DEFAULT_ROLES) {
    const existing = await prisma.role.findUnique({ where: { key: r.key } });
    if (existing) {
      // Operators may have customised a system role; only the super admin is kept in sync with new permissions.
      if (r.key !== 'super_admin') continue;
      await prisma.rolePermission.deleteMany({ where: { roleId: existing.id } });
      await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: existing.id, permissionId: p.id })) });
      continue;
    }
    await prisma.role.create({
      data: {
        key: r.key, name: r.name, description: r.description, isSystem: true, eventScoped: r.eventScoped ?? false,
        permissions: { create: perms.filter((p) => r.permissions.includes(p.key)).map((p) => ({ permissionId: p.id })) },
      },
    });
  }

  const currencies: [string, string, number][] = [
    ['KES', 'Kenyan Shilling', 2], ['USD', 'US Dollar', 2], ['GBP', 'Pound Sterling', 2], ['EUR', 'Euro', 2],
    ['UGX', 'Ugandan Shilling', 2], ['TZS', 'Tanzanian Shilling', 2], ['NGN', 'Nigerian Naira', 2], ['ZAR', 'South African Rand', 2],
  ];
  for (const [code, name, minorUnits] of currencies) {
    await prisma.currency.upsert({ where: { code }, create: { code, name, minorUnits }, update: { name } });
  }

  const providers: [string, string, boolean][] = [['paystack', 'Paystack', false], ['flutterwave', 'Flutterwave', false], ['sandbox', 'Sandbox (test only)', true]];
  for (const [code, name, isTestOnly] of providers) {
    await prisma.paymentProvider.upsert({ where: { code }, create: { code, name, isTestOnly }, update: { name, isTestOnly } });
  }

  for (const [type, t] of Object.entries(DEFAULT_TEMPLATES)) {
    await prisma.emailTemplate.upsert({
      where: { type_channel: { type, channel: 'EMAIL' } },
      create: { type, channel: 'EMAIL', subject: t.subject, bodyHtml: t.bodyHtml },
      update: {},
    });
    if (t.sms) {
      await prisma.emailTemplate.upsert({
        where: { type_channel: { type, channel: 'SMS' } },
        create: { type, channel: 'SMS', subject: type, bodyHtml: t.sms, bodyText: t.sms },
        update: {},
      });
    }
  }

  const settings: [string, unknown][] = [
    ['security.requireMfaForAdmins', { enabled: false }],
    ['reporting.baseCurrency', { code: 'KES' }],
    ['privacy.dataRequestSlaDays', { days: 30 }],
    ['retention.auditLogDays', { days: 2555 }],
    ['retention.webhookPayloadDays', { days: 400 }],
    ['retention.notificationLogDays', { days: 730 }],
  ];
  for (const [key, value] of settings) {
    await prisma.systemSetting.upsert({ where: { key }, create: { key, value: value as object }, update: {} });
  }
}

const days = (n: number) => new Date(Date.now() + n * 86400_000);
const at = (offsetDays: number, hour: number) => {
  const d = days(offsetDays);
  d.setUTCHours(hour - 3, 0, 0, 0); // Nairobi is UTC+3
  return d;
};

export const DEMO_BRANDS = [
  { slug: 'tamasha', name: 'Tamasha Tickets', primaryColor: '#7c2d12', secondaryColor: '#f59e0b', currency: 'KES', entity: 'ke', port: 3100, tagline: 'Concerts and festivals across East Africa' },
  { slug: 'gigpoa', name: 'GigPoa', primaryColor: '#1d4ed8', secondaryColor: '#22d3ee', currency: 'KES', entity: 'ke', port: 3100, tagline: 'Live music, comedy and nightlife' },
  { slug: 'uwanja', name: 'Uwanja Sports', primaryColor: '#166534', secondaryColor: '#facc15', currency: 'KES', entity: 'ke', port: 3100, tagline: 'Football, rugby and athletics tickets' },
  { slug: 'sherehe', name: 'Sherehe Live', primaryColor: '#86198f', secondaryColor: '#fb7185', currency: 'KES', entity: 'ke', port: 3100, tagline: 'Theatre, arts and family days out' },
  { slug: 'pulsepass', name: 'PulsePass', primaryColor: '#0f172a', secondaryColor: '#a3e635', currency: 'GBP', entity: 'uk', port: 3100, tagline: 'African sounds on tour in the UK and Europe' },
] as const;

export async function seedDemo(prisma: PrismaClient) {
  if (await prisma.brand.count()) {
    console.log('Demo data already present, skipping. Run `npx prisma migrate reset` to start over.');
    return;
  }
  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.key, r.id]));

  // ── Legal entities: the storefronts are not automatically one legal seller ──
  const ke = await prisma.legalEntity.create({ data: { name: 'Tamasha Holdings Limited', country: 'KE', registrationNumber: 'PVT-DEMO-0001', taxNumber: 'P000000000A', address: 'Westlands, Nairobi, Kenya' } });
  const uk = await prisma.legalEntity.create({ data: { name: 'PulsePass Events UK Ltd', country: 'GB', registrationNumber: 'DEMO-00000002', address: 'Shoreditch, London, United Kingdom' } });
  const entities = { ke, uk };

  // ── Merchant accounts (sandbox). Real Paystack/Flutterwave accounts are added in Admin → Integrations. ──
  const accounts = {
    ke: await prisma.paymentProviderAccount.create({
      data: { providerCode: 'sandbox', legalEntityId: ke.id, label: 'Sandbox - Tamasha Holdings (KES/USD)', livemode: false, currencies: ['KES', 'USD'], credentialsEnc: encryptJson({ webhookSecret: 'sandbox_whsec_ke_dev_only' }), merchantRef: 'sbx-merchant-ke' },
    }),
    uk: await prisma.paymentProviderAccount.create({
      data: { providerCode: 'sandbox', legalEntityId: uk.id, label: 'Sandbox - PulsePass UK (GBP/EUR)', livemode: false, currencies: ['GBP', 'EUR', 'USD'], credentialsEnc: encryptJson({ webhookSecret: 'sandbox_whsec_uk_dev_only' }), merchantRef: 'sbx-merchant-uk' },
    }),
  };

  const brands: Record<string, { id: string }> = {};
  for (const b of DEMO_BRANDS) {
    const domain = `${b.slug}.localhost:${b.port}`;
    const brand = await prisma.brand.create({
      data: {
        slug: b.slug, name: b.name, primaryColor: b.primaryColor, secondaryColor: b.secondaryColor,
        contactEmail: `help@${b.slug}.example`, supportPhone: b.entity === 'uk' ? '+44 20 7946 0000' : '+254 700 000 000', supportUrl: `http://${domain}/support`,
        businessAddress: entities[b.entity].address, emailSenderName: b.name, emailSenderAddr: `tickets@${b.slug}.example`,
        defaultCurrency: b.currency, currencies: b.entity === 'uk' ? ['GBP', 'EUR'] : ['KES', 'USD'], timezone: b.entity === 'uk' ? 'Europe/London' : 'Africa/Nairobi',
        domains: { create: { domain, isPrimary: true, verifiedAt: new Date() } },
        apiKeys: { create: { label: 'Local development storefront', keyPrefix: demoStorefrontKey(b.slug).slice(0, 12), keyHash: sha256(demoStorefrontKey(b.slug)) } },
        legalEntities: { create: { legalEntityId: entities[b.entity].id, isDefault: true } },
        paymentConfigs: {
          create: {
            providerAccountId: accounts[b.entity].id, currencies: b.entity === 'uk' ? ['GBP', 'EUR'] : ['KES', 'USD'], providerApproved: true,
            approvalNote: 'Sandbox account: no provider approval applies. Replace before going live.',
          },
        },
        settings: { create: [{ key: 'public.tagline', value: { text: b.tagline } }] },
        policies: {
          create: [
            { type: 'TERMS', version: 1, content: `Tickets are sold by ${entities[b.entity].name} trading as ${b.name}. Tickets are valid only for the event, date and category shown and admit one person per ticket. Resale above face value is not permitted.` },
            { type: 'REFUND', version: 1, content: `Refunds are available when an event is cancelled, or rescheduled and you cannot attend the new date. Requests must be made through ${b.name} support and are returned to the original payment method. Service fees are refunded for cancelled events.` },
            { type: 'PRIVACY', version: 1, content: `${b.name} processes your personal data to deliver your tickets and support your order, in line with the Kenya Data Protection Act, 2019 and other applicable law. Marketing is sent only with your consent to ${b.name}; you can withdraw it at any time. You may request access to, correction of, or deletion of your data.` },
          ],
        },
      },
    });
    brands[b.slug] = brand;
  }

  // ── Staff ──
  const pw = await hashPassword(DEMO_PASSWORD);
  const user = (email: string, fullName: string, role: string, brandSlugs: string[] | 'all') =>
    prisma.user.create({
      data: {
        email, fullName, passwordHash: pw, allBrands: brandSlugs === 'all', roles: { create: { roleId: roles[role] } },
        brandAssignments: brandSlugs === 'all' ? undefined : { create: brandSlugs.map((s) => ({ brandId: brands[s].id })) },
      },
    });
  await user('superadmin@ctp.local', 'Wanjiru Kamau', 'super_admin', 'all');
  await user('finance@ctp.local', 'Otieno Odhiambo', 'finance_officer', 'all');
  await user('admin@tamasha.local', 'Amina Hassan', 'brand_admin', ['tamasha']);
  await user('admin@gigpoa.local', 'Brian Mwangi', 'brand_admin', ['gigpoa']);
  await user('admin@pulsepass.local', 'Chloe Adeyemi', 'brand_admin', ['pulsepass']);
  await user('support@tamasha.local', 'Faith Njeri', 'customer_support', ['tamasha', 'gigpoa']);
  await user('marketing@tamasha.local', 'Kevin Kiptoo', 'marketing_manager', ['tamasha']);
  const eventManager = await user('events@ctp.local', 'Mercy Achieng', 'event_manager', ['tamasha', 'gigpoa', 'uwanja', 'sherehe']);
  const scanner = await user('scanner@ctp.local', 'Gate Team A', 'ticket_scanner', ['tamasha', 'gigpoa', 'uwanja', 'sherehe', 'pulsepass']);

  // ── Catalogue reference data ──
  const cat = Object.fromEntries(
    await Promise.all(
      [['concerts', 'Concerts'], ['festivals', 'Festivals'], ['football', 'Football'], ['rugby', 'Rugby'], ['theatre', 'Theatre & Arts'], ['comedy', 'Comedy']].map(async ([slug, name]) => [
        slug, (await prisma.eventCategory.create({ data: { slug, name } })).id,
      ]),
    ),
  );
  const venue = async (name: string, city: string, country: string, capacity: number, address: string, timezone = 'Africa/Nairobi') =>
    (await prisma.venue.create({ data: { name, city, country, capacity, address, timezone } })).id;
  const v = {
    carnivore: await venue('Carnivore Grounds', 'Nairobi', 'Kenya', 15000, 'Langata Road, Nairobi'),
    kasarani: await venue('Kasarani Stadium', 'Nairobi', 'Kenya', 60000, 'Thika Road, Nairobi'),
    kicc: await venue('KICC Tsavo Ballroom', 'Nairobi', 'Kenya', 2500, 'Harambee Avenue, Nairobi'),
    theatre: await venue('Kenya National Theatre', 'Nairobi', 'Kenya', 350, 'Harry Thuku Road, Nairobi'),
    mombasa: await venue('Mama Ngina Waterfront', 'Mombasa', 'Kenya', 8000, 'Mama Ngina Drive, Mombasa'),
    rfuea: await venue('RFUEA Ground', 'Nairobi', 'Kenya', 6000, 'Ngong Road, Nairobi'),
    brixton: await venue('O2 Academy Brixton', 'London', 'United Kingdom', 4900, '211 Stockwell Road, London', 'Europe/London'),
  };
  const performer = async (name: string, type = 'ARTIST') => (await prisma.performer.create({ data: { name, type } })).id;
  const p = {
    zuri: await performer('Zuri Maina & The Highlife Band'), dj: await performer('DJ Kaskazi'), amka: await performer('Amka Collective'),
    simba: await performer('Nairobi Simba FC', 'TEAM'), chui: await performer('Coast Chui United', 'TEAM'),
    sevens: await performer('Savannah Sevens', 'TEAM'), comic: await performer('Mjomba Otis'), players: await performer('The Riverside Players'),
  };
  const organizer = (name: string, legalName: string, email: string, verificationStatus = 'VERIFIED') =>
    prisma.organizer.create({ data: { name, legalName, contactEmail: email, country: 'KE', verificationStatus, settlementCurrency: 'KES', agreementNotes: 'Standard promoter agreement: platform commission per commission rules; payout after event completion.' } });
  const org = {
    savanna: await organizer('Savanna Live Promotions', 'Savanna Live Promotions Ltd', 'accounts@savannalive.example'),
    league: await organizer('Premier League Kenya Events', 'PLK Events Ltd', 'finance@plkevents.example'),
    arts: await organizer('Riverside Arts Trust', 'Riverside Arts Trust', 'hello@riversidearts.example', 'PENDING'),
  };

  // ── Commission rules ──
  await prisma.commissionRule.createMany({
    data: [
      { name: 'Platform commission (default 5%)', type: 'PLATFORM_COMMISSION', percentBps: 500 },
      { name: 'Service fee (default 4%)', type: 'SERVICE_FEE', percentBps: 400 },
      { name: 'Premier League Kenya negotiated commission (3.5%)', type: 'PLATFORM_COMMISSION', organizerId: org.league.id, percentBps: 350 },
      { name: 'GigPoa brand commission (2%)', type: 'BRAND_COMMISSION', brandId: brands.gigpoa.id, percentBps: 200 },
      { name: 'PulsePass service fee (6% + GBP 0.50 per ticket)', type: 'SERVICE_FEE', brandId: brands.pulsepass.id, percentBps: 600, fixedMinor: 50n, currency: 'GBP' },
    ],
  });

  // ── Events: one master record and one inventory pool each, published to several storefronts ──
  type Cat = { name: string; price: number; total: number; max?: number; description?: string };
  const event = async (e: {
    slug: string; name: string; description: string; category: string; venueId: string; organizerId: string; startsAt: Date; hours: number;
    performers: string[]; brands: string[]; categories: Cat[]; currency?: string; status?: 'PUBLISHED' | 'DRAFT' | 'SCHEDULED'; timezone?: string;
    custom?: Record<string, { customTitle?: string; customDescription?: string; featured?: boolean }>;
  }) => {
    const created = await prisma.event.create({
      data: {
        slug: e.slug, name: e.name, description: e.description, categoryId: cat[e.category], venueId: e.venueId, organizerId: e.organizerId,
        startsAt: e.startsAt, endsAt: new Date(e.startsAt.getTime() + e.hours * 3600_000), doorsAt: new Date(e.startsAt.getTime() - 3600_000),
        timezone: e.timezone ?? 'Africa/Nairobi', status: e.status ?? 'PUBLISHED', publishAt: e.status === 'SCHEDULED' ? days(2) : null,
        policies: 'No re-entry. Valid ID may be required. Children under 12 must be accompanied by an adult.',
        performers: { create: e.performers.map((performerId, billing) => ({ performerId, billing })) },
        publications: { create: e.brands.map((s) => ({ brandId: brands[s].id, ...(e.custom?.[s] ?? {}) })) },
      },
    });
    for (const [i, c] of e.categories.entries()) {
      const tc = await prisma.ticketCategory.create({
        data: { eventId: created.id, name: c.name, description: c.description, priceMinor: BigInt(c.price * 100), currency: e.currency ?? 'KES', maxPerOrder: c.max ?? 8, sortOrder: i },
      });
      await prisma.ticketInventory.create({ data: { ticketCategoryId: tc.id, total: c.total } });
      await prisma.inventoryMovement.create({ data: { ticketCategoryId: tc.id, type: 'INITIAL', quantity: c.total, deltaTotal: c.total, note: 'Seed' } });
    }
    return created;
  };

  const festival = await event({
    slug: 'nairobi-highlife-festival', name: 'Nairobi Highlife Festival', category: 'festivals', venueId: v.carnivore, organizerId: org.savanna.id,
    description: 'Two stages, twelve acts and the best street food in the city. Headlined by Zuri Maina & The Highlife Band.',
    startsAt: at(21, 14), hours: 9, performers: [p.zuri, p.dj, p.amka], brands: ['tamasha', 'gigpoa', 'uwanja', 'sherehe'],
    categories: [{ name: 'Early Bird', price: 2000, total: 300 }, { name: 'General Admission', price: 3000, total: 1000 }, { name: 'VIP', price: 8500, total: 150, max: 6 }, { name: 'Platinum Table', price: 60000, total: 20, max: 2, description: 'Table for eight with bottle service' }],
    custom: { tamasha: { featured: true }, gigpoa: { customTitle: 'Highlife Fest 2026 - Nairobi', customDescription: 'The biggest highlife party of the year. Grab your squad and your GigPoa tickets.' } },
  });
  await event({
    slug: 'mashemeji-derby', name: 'Mashemeji Derby: Nairobi Simba vs Coast Chui', category: 'football', venueId: v.kasarani, organizerId: org.league.id,
    description: 'The fiercest rivalry in Kenyan football returns to Kasarani.', startsAt: at(10, 16), hours: 2, performers: [p.simba, p.chui],
    brands: ['uwanja', 'tamasha'], categories: [{ name: 'Terraces', price: 300, total: 20000, max: 10 }, { name: 'Regular', price: 600, total: 12000 }, { name: 'VIP', price: 2500, total: 1500 }],
    custom: { uwanja: { featured: true } },
  });
  await event({
    slug: 'safari-sevens-finals', name: 'Savannah Sevens Finals Day', category: 'rugby', venueId: v.rfuea, organizerId: org.league.id,
    description: 'Finals day of the international sevens tournament, with the after-party on the main pitch.', startsAt: at(35, 10), hours: 10, performers: [p.sevens],
    brands: ['uwanja', 'gigpoa'], categories: [{ name: 'General Admission', price: 1500, total: 4000 }, { name: 'Gold', price: 4000, total: 600 }],
  });
  await event({
    slug: 'coastal-sunset-sessions', name: 'Coastal Sunset Sessions', category: 'concerts', venueId: v.mombasa, organizerId: org.savanna.id,
    description: 'An oceanfront evening of taarab, bongo flava and coastal house.', startsAt: at(14, 17), hours: 6, performers: [p.dj, p.amka],
    brands: ['tamasha', 'gigpoa'], categories: [{ name: 'Regular', price: 1500, total: 2500 }, { name: 'Silver', price: 3500, total: 400 }, { name: 'Gold', price: 6000, total: 120 }],
  });
  await event({
    slug: 'mjomba-otis-live', name: 'Mjomba Otis Live: Kicheko Tu', category: 'comedy', venueId: v.kicc, organizerId: org.savanna.id,
    description: 'A night of stand-up from Kenya\'s favourite uncle.', startsAt: at(7, 19), hours: 3, performers: [p.comic],
    brands: ['gigpoa', 'sherehe'], categories: [{ name: 'Regular', price: 1200, total: 1800 }, { name: 'VIP', price: 3000, total: 300 }],
  });
  await event({
    slug: 'the-river-between', name: 'The River Between: A Stage Adaptation', category: 'theatre', venueId: v.theatre, organizerId: org.arts.id,
    description: 'A new stage adaptation performed by The Riverside Players. Limited run, reserved seating.', startsAt: at(5, 18), hours: 2, performers: [p.players],
    brands: ['sherehe'], categories: [{ name: 'Reserved Seating', price: 1000, total: 280, max: 6 }, { name: 'Premium', price: 2000, total: 70, max: 4 }],
    custom: { sherehe: { featured: true } },
  });
  await event({
    slug: 'afrobeats-to-the-world-london', name: 'Afrobeats to the World: London', category: 'concerts', venueId: v.brixton, organizerId: org.savanna.id,
    description: 'Zuri Maina & The Highlife Band bring the tour to Brixton for one night only.', startsAt: at(45, 22), hours: 4, performers: [p.zuri, p.dj],
    brands: ['pulsepass'], currency: 'GBP', timezone: 'Europe/London', categories: [{ name: 'Standing', price: 35, total: 3500 }, { name: 'Balcony Seated', price: 48, total: 1000 }, { name: 'VIP', price: 95, total: 200, max: 4 }],
    custom: { pulsepass: { featured: true } },
  });
  await event({
    slug: 'new-year-countdown', name: 'New Year Countdown at the Waterfront', category: 'festivals', venueId: v.mombasa, organizerId: org.savanna.id,
    description: 'Ring in the new year on the coast. Line-up to be announced.', startsAt: at(46, 20), hours: 6, performers: [p.dj],
    brands: ['tamasha'], status: 'SCHEDULED', categories: [{ name: 'Early Bird', price: 2500, total: 500 }, { name: 'General Admission', price: 4000, total: 3000 }],
  });

  await prisma.userEventAssignment.createMany({
    data: (await prisma.event.findMany({ select: { id: true } })).flatMap((e) => [{ userId: eventManager.id, eventId: e.id }, { userId: scanner.id, eventId: e.id }]),
  });

  // ── Marketing: a promo code and a segment per KES brand ──
  await prisma.promoCode.createMany({
    data: [
      { brandId: brands.tamasha.id, code: 'KARIBU10', description: '10% off your first order', discountType: 'PERCENT', percentBps: 1000, maxRedemptions: 500 },
      { brandId: brands.gigpoa.id, code: 'POA500', description: 'KES 500 off orders over KES 3,000', discountType: 'FIXED', amountMinor: 50000n, currency: 'KES', minOrderMinor: 300000n },
      { brandId: brands.tamasha.id, code: 'HIGHLIFE', description: '15% off Nairobi Highlife Festival', discountType: 'PERCENT', percentBps: 1500, eventId: festival.id, endsAt: days(20) },
    ],
  });
  await prisma.customerSegment.createMany({
    data: [
      { brandId: brands.tamasha.id, name: 'Festival goers', description: 'Bought a festival ticket', rules: { eventCategory: 'festivals' } },
      { brandId: brands.tamasha.id, name: 'High-value customers', description: 'Spent KES 10,000 or more', rules: { minSpendMinor: 1000000, currency: 'KES' } },
      { brandId: brands.tamasha.id, name: 'Lapsed (6 months)', description: 'No purchase in the last 180 days', rules: { inactiveDays: 180 } },
      { brandId: brands.uwanja.id, name: 'Football fans', description: 'Attended a football event', rules: { eventCategory: 'football' } },
      { brandId: brands.gigpoa.id, name: 'Abandoned checkout', description: 'Started but did not complete a purchase', rules: { abandonedCheckout: true } },
    ],
  });

  await prisma.exchangeRate.createMany({
    data: [
      { base: 'USD', quote: 'KES', rate: '129.25', asOf: new Date(), source: 'manual-demo' },
      { base: 'GBP', quote: 'KES', rate: '163.40', asOf: new Date(), source: 'manual-demo' },
      { base: 'EUR', quote: 'KES', rate: '140.10', asOf: new Date(), source: 'manual-demo' },
    ],
  });

  console.log('\nDemo data created.');
  console.log(`  Admin sign-in (all demo staff share this development password): ${DEMO_PASSWORD}`);
  console.log('    superadmin@ctp.local   Super Administrator (all brands)');
  console.log('    finance@ctp.local      Finance Officer (all brands)');
  console.log('    admin@tamasha.local    Brand Administrator (Tamasha Tickets)');
  console.log('    admin@gigpoa.local     Brand Administrator (GigPoa)');
  console.log('    support@tamasha.local  Customer Support (Tamasha, GigPoa)');
  console.log('    marketing@tamasha.local Marketing Manager (Tamasha)');
  console.log('    events@ctp.local       Event Manager     scanner@ctp.local  Ticket Scanner');
  console.log('  Storefront API keys (development only):');
  for (const b of DEMO_BRANDS) console.log(`    ${b.name.padEnd(16)} http://${b.slug}.localhost:${b.port}  ${demoStorefrontKey(b.slug)}`);
}

if (require.main === module) {
  const prisma = new PrismaClient();
  (async () => {
    await seedBase(prisma);
    if (process.env.NODE_ENV === 'production' || process.env.SEED_DEMO === 'false') {
      console.log('Base reference data seeded (demo data skipped).');
    } else {
      await seedDemo(prisma);
    }
  })()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
