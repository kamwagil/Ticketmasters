import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { site } from '@/lib/api';

/**
 * Where the payment gateway sends the buyer back. Query parameters added by the gateway
 * (status, reference, ...) are deliberately ignored: the order is identified from the httpOnly
 * cookie set at checkout, and the order page then asks the platform for the real payment state.
 */
export async function GET(_req: NextRequest) {
  const s = await site();
  const origin = s?.origin ?? 'http://localhost:3100';
  let target = '/orders';
  try {
    const raw = (await cookies()).get('sf_co')?.value;
    const v = raw ? (JSON.parse(raw) as { ref?: string; email?: string }) : null;
    if (v?.ref && /^[A-Z0-9-]{6,40}$/.test(v.ref) && v.email) target = `/orders/${v.ref}?email=${encodeURIComponent(v.email)}`;
  } catch {
    /* fall back to the lookup form */
  }
  return NextResponse.redirect(new URL(target, origin), 303);
}
