import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import { decrypt } from '../../common/crypto';
import { PrismaService } from '../../common/infra';

export interface TicketDoc {
  filename: string;
  content: Buffer;
}

function when(d: Date, tz: string) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(d);
}

/** Renders ticket PDFs on demand. Nothing is cached: a revoked ticket can never be re-downloaded as valid. */
@Injectable()
export class TicketDocumentService {
  constructor(private prisma: PrismaService) {}

  /** The QR payload: an opaque random token. It carries no personal data and no ticket id. */
  async qrPayload(ticketId: string): Promise<string | null> {
    const t = await this.prisma.ticketQrToken.findFirst({ where: { ticketId, active: true } });
    return t ? decrypt(t.tokenEnc) : null;
  }

  /** QR as SVG markup. Vector output is generated in well under a millisecond; raster PNG encoding is not. */
  async qrSvg(ticketId: string): Promise<string | null> {
    const payload = await this.qrPayload(ticketId);
    return payload ? QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }) : null;
  }

  async renderOrderTickets(orderId: string): Promise<TicketDoc[]> {
    const tickets = await this.prisma.ticket.findMany({ where: { orderId, status: 'VALID' }, orderBy: { reference: 'asc' }, select: { id: true } });
    const docs: TicketDoc[] = [];
    for (const t of tickets) {
      const d = await this.render(t.id);
      if (d) docs.push(d);
    }
    return docs;
  }

  async render(ticketId: string): Promise<TicketDoc | null> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { event: { include: { venue: true } }, ticketCategory: true, order: { include: { brand: true, legalEntity: true } } },
    });
    if (!ticket) return null;
    const payload = await this.qrPayload(ticketId);
    const brand = ticket.order.brand;
    const ev = ticket.event;

    const doc = new PDFDocument({ size: [420, 640], margin: 0, info: { Title: `Ticket ${ticket.reference}`, Author: brand.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve) => doc.on('end', resolve));

    doc.rect(0, 0, 420, 96).fill(brand.primaryColor);
    doc.rect(0, 96, 420, 5).fill(brand.secondaryColor);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text(brand.name, 28, 30, { width: 364 });
    doc.font('Helvetica').fontSize(10).text('E-TICKET  ·  ADMIT ONE', 28, 62, { characterSpacing: 1.2 });

    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(18).text(ev.name, 28, 124, { width: 364 });
    let y = doc.y + 10;
    const row = (label: string, value: string) => {
      doc.fillColor('#64748b').font('Helvetica').fontSize(8).text(label.toUpperCase(), 28, y, { characterSpacing: 0.8 });
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text(value, 28, y + 11, { width: 364 });
      y = doc.y + 9;
    };
    row('Date & time', when(ev.startsAt, ev.timezone));
    row('Venue', ev.venue ? `${ev.venue.name}, ${ev.venue.city}` : 'To be announced');
    row('Ticket type', ticket.ticketCategory.name);
    if (ticket.holderName) row('Ticket holder', ticket.holderName);

    const qrTop = Math.max(y + 8, 330);
    if (payload && ticket.status === 'VALID') {
      // Draw the QR modules as vector squares: sharp at any print size and no image encoding.
      const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
      const n = qr.modules.size;
      const cell = 200 / (n + 2);
      doc.rect(110, qrTop, 200, 200).fill('#ffffff');
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.modules.get(r, c)) doc.rect(110 + (c + 1) * cell, qrTop + (r + 1) * cell, cell + 0.2, cell + 0.2);
        }
      }
      doc.fill('#000000');
    } else {
      doc.rect(110, qrTop, 200, 200).lineWidth(1).stroke('#cbd5e1');
      doc.fillColor('#b91c1c').font('Helvetica-Bold').fontSize(16).text(`NOT VALID\n${ticket.status}`, 110, qrTop + 80, { width: 200, align: 'center' });
    }
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(12).text(ticket.reference, 28, qrTop + 208, { width: 364, align: 'center', characterSpacing: 1.5 });
    doc.fillColor('#64748b').font('Helvetica').fontSize(8)
      .text(`Order ${ticket.order.reference}  ·  Sold by ${ticket.order.legalEntity.name}`, 28, qrTop + 228, { width: 364, align: 'center' })
      .text(`This ticket admits one person and is valid for a single scan. Support: ${brand.contactEmail}`, 28, qrTop + 242, { width: 364, align: 'center' });
    doc.end();
    await done;
    return { filename: `ticket-${ticket.reference}.pdf`, content: Buffer.concat(chunks) };
  }
}
