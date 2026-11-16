import { NextRequest, NextResponse } from 'next/server';
import { checkoutAction, CheckoutInput } from '@/app/actions';
import { site } from '@/lib/api';

/**
 * Same-origin endpoint the checkout form posts to. It runs on this storefront's server, which
 * adds the storefront key and calls the central API. Cross-site posts are refused.
 */
export async function POST(req: NextRequest) {
  const s = await site();
  if (!s) return NextResponse.json({ ok: false, error: 'This storefront is not configured' }, { status: 503 });
  const origin = req.headers.get('origin');
  if (origin && origin !== s.origin) return NextResponse.json({ ok: false, error: 'Cross-site request refused' }, { status: 403 });
  let body: CheckoutInput;
  try {
    body = (await req.json()) as CheckoutInput;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request' }, { status: 400 });
  }
  if (!body || !Array.isArray(body.items) || typeof body.customer !== 'object' || !body.customer) {
    return NextResponse.json({ ok: false, error: 'Invalid request' }, { status: 400 });
  }
  const result = await checkoutAction(body);
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
