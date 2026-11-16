import { humanize } from '@/lib/format';

export interface TicketView {
  id: string;
  reference: string;
  status: string;
  category: string;
  holderName: string | null;
  qrSvg: string | null;
}

/**
 * The QR markup comes from the central platform (never from user input) and is inlined only
 * if it is an SVG document without script content.
 */
export function safeQr(svg: string | null): string | null {
  if (!svg) return null;
  const s = svg.trim();
  if (!s.startsWith('<svg') || /<script|on\w+\s*=|javascript:/i.test(s)) return null;
  return s;
}

export function TicketCard({ ticket, pdfHref, children }: { ticket: TicketView; pdfHref: string | null; children?: React.ReactNode }) {
  const qr = ticket.status === 'VALID' ? safeQr(ticket.qrSvg) : null;
  return (
    <div className="card flex h-full flex-col items-center text-center">
      <p className="text-sm font-semibold text-slate-900">{ticket.category}</p>
      {ticket.holderName && <p className="text-xs text-slate-500">{ticket.holderName}</p>}
      {qr ? (
        <div role="img" aria-label={`QR code for ticket ${ticket.reference}`} className="my-3 h-44 w-44 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: qr }} />
      ) : (
        <div className="my-3 grid h-44 w-44 place-items-center rounded-lg bg-slate-100 px-3 text-sm font-semibold text-slate-600">
          {ticket.status === 'VALID' ? 'QR code unavailable' : `${humanize(ticket.status)} - not valid for entry`}
        </div>
      )}
      <p className="font-mono text-sm tracking-wider text-slate-800">{ticket.reference}</p>
      {pdfHref && <a href={pdfHref} className="btn-secondary mt-3 h-10">Download PDF</a>}
      {children}
    </div>
  );
}
