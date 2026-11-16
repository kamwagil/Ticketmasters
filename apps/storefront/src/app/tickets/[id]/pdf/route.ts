import { NextRequest, NextResponse } from 'next/server';
import { apiRaw } from '@/lib/api';

/**
 * Streams a ticket PDF from the central API through this storefront, so the browser never
 * learns the API address or the storefront key. Access is decided by the API: the signed-in
 * owner, or a guest presenting the order (or ticket) reference and matching email.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse('Not found', { status: 404 });
  const q = req.nextUrl.searchParams;
  const res = await apiRaw(`/tickets/${id}/download`, { orderReference: q.get('orderReference'), ticketReference: q.get('ticketReference'), email: q.get('email') });
  if (!(res instanceof Response)) {
    return new NextResponse(res.status === 404 ? 'Ticket not found' : res.message, { status: res.status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return new NextResponse(res.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': res.headers.get('content-disposition') ?? 'attachment; filename="ticket.pdf"',
      'Cache-Control': 'private, no-store',
    },
  });
}
