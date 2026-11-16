import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { logoutAction } from './actions';
import { getBrand, getBrandSettings, getMe, site } from '@/lib/api';
import { inkFor, readableOn, safeColor } from '@/lib/format';
import './globals.css';

export const dynamic = 'force-dynamic'; // every request is rendered for its own host/brand

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrand();
  if (!brand.ok) return { title: 'Storefront' };
  const settings = await getBrandSettings();
  return { title: { default: brand.data.name, template: `%s · ${brand.data.name}` }, description: settings.tagline?.text ?? `Tickets from ${brand.data.name}` };
}
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

function Plain({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="mx-auto max-w-lg px-6 py-24 text-center">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <div className="mt-3 text-slate-600">{children}</div>
        </main>
      </body>
    </html>
  );
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const s = await site();
  if (!s) {
    return (
      <Plain title="Storefront not configured">
        <p>No storefront is configured for this address. Check the host name, or add it to the storefront configuration.</p>
      </Plain>
    );
  }
  const res = await getBrand();
  if (!res.ok) {
    return (
      <Plain title="We will be right back">
        <p>{res.error.code === 'API_UNREACHABLE' ? res.error.message : 'This storefront is temporarily unavailable.'}</p>
      </Plain>
    );
  }
  const brand = res.data;
  const me = await getMe();
  const primary = safeColor(brand.primaryColor, '#0f172a');
  const accent = safeColor(brand.secondaryColor, '#f59e0b');
  // The whole theme comes from the brand record held by the central platform.
  const theme = { '--brand': primary, '--brand-fg': readableOn(primary), '--accent': accent, '--accent-fg': readableOn(accent), '--brand-ink': inkFor(primary) } as React.CSSProperties;

  return (
    <html lang="en" style={theme}>
      <body className="flex min-h-screen flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">Skip to content</a>
        <header className="bg-brand text-brand-fg">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-4 sm:px-6">
            <Link href="/" className="flex items-center gap-3 text-lg font-bold tracking-tight">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {brand.logoUrl ? <img src={brand.logoUrl} alt={brand.name} className="h-8 w-auto" /> : brand.name}
            </Link>
            <nav aria-label="Main" className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm font-medium">
              <Link href="/" className="hover:underline">Events</Link>
              <Link href="/orders" className="hover:underline">Find my order</Link>
              <Link href="/support" className="hover:underline">Help</Link>
              {me ? (
                <>
                  <Link href="/account" className="hover:underline">My account</Link>
                  <form action={logoutAction}><button className="hover:underline">Sign out</button></form>
                </>
              ) : (
                <Link href="/account/login" className="rounded-md bg-brand-accent px-3 py-1.5 text-brand-accent-fg hover:opacity-90">Sign in</Link>
              )}
            </nav>
          </div>
          <div className="h-1 bg-brand-accent" />
        </header>

        {!brand.acceptingOrders && (
          <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm text-amber-900">
            <strong>{brand.name} is not currently accepting new orders.</strong> You can still look up existing orders and open your tickets.
          </div>
        )}

        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>

        <footer className="mt-8 border-t border-slate-200 bg-white">
          <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 text-sm text-slate-600 sm:grid-cols-3 sm:px-6">
            <div>
              <div className="font-semibold text-slate-900">{brand.name}</div>
              {brand.businessAddress && <p className="mt-1">{brand.businessAddress}</p>}
            </div>
            <div>
              <div className="font-semibold text-slate-900">Contact</div>
              <p className="mt-1"><a className="link" href={`mailto:${brand.contactEmail}`}>{brand.contactEmail}</a></p>
              {brand.supportPhone && <p><a className="link" href={`tel:${brand.supportPhone.replace(/\s/g, '')}`}>{brand.supportPhone}</a></p>}
              <p><Link className="link" href="/support">Contact support</Link></p>
            </div>
            <div>
              <div className="font-semibold text-slate-900">Policies</div>
              <ul className="mt-1 space-y-0.5">
                <li><Link className="link" href="/terms">Terms and conditions</Link></li>
                <li><Link className="link" href="/refund-policy">Refund policy</Link></li>
                <li><Link className="link" href="/privacy">Privacy policy</Link></li>
              </ul>
            </div>
          </div>
          <p className="border-t border-slate-100 px-4 py-4 text-center text-xs text-slate-500">
            Tickets by {brand.name}. Powered by the central ticketing platform (demo storefront).
          </p>
        </footer>
      </body>
    </html>
  );
}
