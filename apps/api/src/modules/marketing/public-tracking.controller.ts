import { Controller, Get, Header, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RateLimit, RateLimitGuard } from '../../common/auth';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/infra';
import { CustomerService } from '../customers/customer.service';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string, color = '#0f172a') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f1f5f9;color:#0f172a;display:grid;place-items:center;min-height:100vh}
.card{background:#fff;border-radius:14px;padding:32px;max-width:440px;width:calc(100% - 32px);box-sizing:border-box;box-shadow:0 10px 30px rgba(15,23,42,.08);border-top:5px solid ${color}}
h1{font-size:20px;margin:0 0 10px}p{color:#475569;font-size:15px;line-height:1.55;margin:0 0 14px}
button{padding:12px 20px;border:0;border-radius:9px;font-size:15px;font-weight:600;cursor:pointer;background:${color};color:#fff}</style></head>
<body><div class="card">${body}</div></body></html>`;
}

/**
 * Unauthenticated endpoints reached from links inside marketing messages. The random
 * per-recipient tracking token is the only credential and identifies one delivery.
 */
@ApiTags('Public · Tracking')
@Controller('v1/public')
@UseGuards(RateLimitGuard)
export class PublicTrackingController {
  constructor(private prisma: PrismaService, private customers: CustomerService) {}

  private async delivery(token: string) {
    if (!TOKEN.test(token)) return null;
    return this.prisma.campaignDelivery.findUnique({ where: { trackingToken: token }, include: { campaign: true } });
  }

  private logEvent(d: NonNullable<Awaited<ReturnType<PublicTrackingController['delivery']>>>, event: string, detail?: string) {
    return this.prisma.notificationLog.create({
      data: { brandId: d.campaign.brandId, customerId: d.customerId, channel: d.campaign.channel, type: 'MARKETING', toAddress: d.toAddress, subject: d.campaign.subject, event, detail },
    }).catch(() => undefined);
  }

  /** Open-tracking pixel. Always answers with the same image, whether or not the token is known. */
  @Get('o/:file')
  @RateLimit({ limit: 600, windowSec: 60 })
  async open(@Param('file') file: string, @Res() res: Response) {
    const d = await this.delivery(file.replace(/\.gif$/i, ''));
    if (d) {
      const first = await this.prisma.campaignDelivery.updateMany({ where: { id: d.id, openedAt: null }, data: { openedAt: new Date() } });
      if (first.count === 1) await this.logEvent(d, 'OPENED');
    }
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Content-Length', String(GIF.length));
    res.end(GIF);
  }

  /** Click tracking. Redirects only for a known delivery token and an http(s) target. */
  @Get('c/:token')
  @RateLimit({ limit: 300, windowSec: 60 })
  async click(@Param('token') token: string, @Query('u') u: string | undefined, @Res() res: Response) {
    const d = await this.delivery(token);
    let target: URL | null = null;
    try {
      target = typeof u === 'string' && u.length <= 2000 ? new URL(u) : null;
    } catch {
      target = null;
    }
    if (!d || !target || !['http:', 'https:'].includes(target.protocol)) throw new AppError('INVALID_LINK', 'This link is not valid', 400);
    await this.prisma.campaignDelivery.update({ where: { id: d.id }, data: { clickCount: { increment: 1 }, clickedAt: d.clickedAt ?? new Date(), openedAt: d.openedAt ?? new Date() } });
    if (!d.clickedAt) await this.logEvent(d, 'CLICKED', target.origin + target.pathname);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, target.toString());
  }

  /** Confirmation page. Unsubscribing needs the button (POST) so link scanners cannot trigger it. */
  @Get('unsubscribe/:token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
  @Header('Cache-Control', 'no-store')
  @RateLimit({ limit: 120, windowSec: 60 })
  async unsubscribePage(@Param('token') token: string) {
    const d = await this.delivery(token);
    if (!d) return page('Link not valid', '<h1>This link is not valid</h1><p>It may have been copied incorrectly. Use the unsubscribe link in a recent message.</p>');
    const brand = await this.prisma.brand.findUniqueOrThrow({ where: { id: d.campaign.brandId } });
    const what = d.campaign.channel === 'EMAIL' ? 'marketing emails' : d.campaign.channel === 'SMS' ? 'marketing text messages' : 'marketing WhatsApp messages';
    if (d.unsubscribedAt) return page('Unsubscribed', `<h1>You are unsubscribed</h1><p>You will no longer receive ${what} from ${esc(brand.name)}.</p>`, brand.primaryColor);
    return page(
      `Unsubscribe from ${brand.name}`,
      `<h1>Unsubscribe from ${esc(brand.name)}?</h1><p>You will stop receiving ${what} from ${esc(brand.name)}. Order confirmations and tickets are still sent. Your choices for other companies are not affected.</p>
<form method="post"><button type="submit">Unsubscribe</button></form>`,
      brand.primaryColor,
    );
  }

  /** Withdraws marketing consent for this brand and channel only. Also the RFC 8058 one-click target. */
  @Post('unsubscribe/:token')
  @HttpCode(200)
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  @Header('Cache-Control', 'no-store')
  @RateLimit({ limit: 60, windowSec: 60 })
  async unsubscribe(@Param('token') token: string) {
    const d = await this.delivery(token);
    if (!d) throw new AppError('INVALID_LINK', 'This link is not valid', 400);
    const brand = await this.prisma.brand.findUniqueOrThrow({ where: { id: d.campaign.brandId } });
    await this.customers.recordConsent(this.prisma, d.customerId, d.campaign.brandId, d.campaign.channel, 'WITHDRAWN', 'unsubscribe_link');
    const first = await this.prisma.campaignDelivery.updateMany({ where: { id: d.id, unsubscribedAt: null }, data: { unsubscribedAt: new Date() } });
    if (first.count === 1) await this.logEvent(d, 'UNSUBSCRIBED');
    return page('Unsubscribed', `<h1>You are unsubscribed</h1><p>${esc(brand.name)} will no longer send you marketing on this channel. You can opt in again at any time from your account.</p>`, brand.primaryColor);
  }
}
