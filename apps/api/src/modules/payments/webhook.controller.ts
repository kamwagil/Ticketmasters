import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { RateLimit, RateLimitGuard } from '../../common/auth';
import { config } from '../../common/config';
import { log } from '../../common/context';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/infra';
import { formatMoney } from '../../common/util';
import { PaymentService } from './payment.service';
import { ProviderRegistry } from './providers';

@ApiTags('Payment webhooks')
@Controller('v1/webhooks')
@UseGuards(RateLimitGuard)
export class WebhookController {
  constructor(private payments: PaymentService) {}

  /**
   * Gateway webhook receiver. Configure this URL (it is specific to one merchant account)
   * in the provider dashboard. The request is authenticated by its signature, stored once
   * and processed asynchronously; duplicates are acknowledged without being re-processed.
   */
  @Post(':provider/:accountId')
  @HttpCode(200)
  @RateLimit({ limit: 6000, windowSec: 60 })
  receive(@Param('provider') provider: string, @Param('accountId', ParseUUIDPipe) accountId: string, @Req() req: Request & { rawBody?: Buffer }) {
    if (!req.rawBody?.length) throw new AppError('INVALID_PAYLOAD', 'Empty webhook body', 400);
    return this.payments.receiveWebhook(provider, accountId, req.headers, req.rawBody);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Hosted checkout page of the built-in SANDBOX gateway (development and tests only).
 * It plays the role of the external provider: the buyer chooses an outcome, the gateway
 * sends a signed webhook to the platform and redirects the buyer back to the storefront.
 */
@ApiExcludeController()
@Controller('sandbox-gateway')
export class SandboxGatewayController {
  constructor(private prisma: PrismaService, private registry: ProviderRegistry, private payments: PaymentService) {}

  private guard() {
    if (config.isProd && !config.allowSandboxProvider) throw new AppError('NOT_FOUND', 'Not found', 404);
  }

  /**
   * Settles a sandbox transaction and builds the signed webhook the gateway would send.
   * Exposed so automated tests can deliver (and re-deliver) the exact same webhook.
   */
  async settle(paymentReference: string, outcome: 'success' | 'failed') {
    const t = await this.prisma.sandboxGatewayTransaction.findUnique({ where: { reference: paymentReference } });
    if (!t) throw new AppError('NOT_FOUND', 'Unknown sandbox transaction', 404);
    await this.prisma.sandboxGatewayTransaction.updateMany({ where: { reference: paymentReference, status: 'pending' }, data: { status: outcome } });
    const account = await this.payments.accountCtx(t.providerAccountId);
    const rawBody = JSON.stringify({
      id: `evt_${randomUUID()}`, event: outcome === 'success' ? 'charge.success' : 'charge.failed',
      data: { reference: t.reference, id: t.transactionId, amount: Number(t.amountMinor), currency: t.currency },
    });
    return { accountId: t.providerAccountId, rawBody, signature: this.registry.sandbox.signature(account, rawBody), callbackUrl: t.callbackUrl };
  }

  @Get('pay/:reference')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
  async page(@Param('reference') ref: string) {
    this.guard();
    const t = await this.prisma.sandboxGatewayTransaction.findUnique({ where: { reference: ref } });
    if (!t) throw new AppError('NOT_FOUND', 'Unknown sandbox transaction', 404);
    const settled = t.status !== 'pending';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbox payment</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f1f5f9;color:#0f172a;display:grid;place-items:center;min-height:100vh}
.card{background:#fff;border-radius:14px;padding:32px;max-width:400px;width:calc(100% - 32px);box-sizing:border-box;box-shadow:0 10px 30px rgba(15,23,42,.08)}
.flag{background:#fef3c7;color:#92400e;font-size:12px;font-weight:700;letter-spacing:.06em;padding:6px 10px;border-radius:6px;display:inline-block}
h1{font-size:28px;margin:18px 0 4px}p{color:#475569;font-size:14px;line-height:1.5}
button{width:100%;padding:13px;border:0;border-radius:9px;font-size:15px;font-weight:600;cursor:pointer;margin-top:10px}
.ok{background:#0f766e;color:#fff}.no{background:#e2e8f0;color:#0f172a}</style></head><body><div class="card">
<span class="flag">SANDBOX GATEWAY - NO REAL MONEY</span>
<h1>${esc(formatMoney(t.amountMinor, t.currency))}</h1>
<p>Test payment <strong>${esc(t.reference)}</strong> for ${esc(t.email)}.<br>This page simulates a payment provider's hosted checkout. No card details are collected and nothing is charged.</p>
${settled ? `<p><strong>This transaction is already ${esc(t.status)}.</strong></p>` : `<form method="post"><input type="hidden" name="outcome" value="success"><button class="ok">Approve test payment</button></form>
<form method="post"><input type="hidden" name="outcome" value="failed"><button class="no">Decline test payment</button></form>`}
</div></body></html>`;
  }

  @Post('pay/:reference')
  async complete(@Param('reference') ref: string, @Body() body: { outcome?: string }, @Res() res: Response) {
    this.guard();
    const outcome = body?.outcome === 'success' ? 'success' : 'failed';
    const s = await this.settle(ref, outcome);
    try {
      // Delivered over HTTP like a real gateway would, so signature checking and idempotency are exercised.
      await fetch(`${config.apiPublicUrl}/v1/webhooks/sandbox/${s.accountId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sandbox-signature': s.signature }, body: s.rawBody, signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      log.warn('sandbox_webhook_delivery_failed', { reference: ref, error: (e as Error).message }); // the pending-payment sweep will still verify it
    }
    const back = new URL(s.callbackUrl);
    back.searchParams.set('reference', ref);
    back.searchParams.set('status', outcome); // informational only: storefronts must not trust this
    res.redirect(303, back.toString());
  }
}
