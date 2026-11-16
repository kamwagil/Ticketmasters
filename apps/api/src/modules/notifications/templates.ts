/**
 * Platform default notification templates (Handlebars). Seeded into `email_templates`;
 * a brand can override any of them in `brand_email_templates`. Every email is wrapped in
 * LAYOUT, which applies the originating brand's logo, colours, sender and contact details.
 */
export const NOTIFICATION_TYPES = [
  'REGISTRATION_CONFIRMATION', 'EMAIL_VERIFICATION', 'PASSWORD_RESET', 'ORDER_CONFIRMATION', 'PAYMENT_CONFIRMATION', 'TICKET_DELIVERY',
  'EVENT_REMINDER', 'EVENT_POSTPONEMENT', 'EVENT_CANCELLATION', 'REFUND_CONFIRMATION', 'TICKET_TRANSFER', 'SELLER_NOTIFICATION',
  'SUPPORT_UPDATE', 'MARKETING',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Types a customer cannot opt out of because they are needed to deliver the service. */
export const TRANSACTIONAL_TYPES = new Set<string>(NOTIFICATION_TYPES.filter((t) => t !== 'MARKETING' && t !== 'EVENT_REMINDER'));

export const LAYOUT = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{subject}}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background:{{brand.primaryColor}};padding:24px 32px;">
{{#if brand.logoUrl}}<img src="{{brand.logoUrl}}" alt="{{brand.name}}" height="36" style="display:block;border:0;max-height:36px;">{{else}}<span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:.2px;">{{brand.name}}</span>{{/if}}
</td></tr>
<tr><td style="height:4px;background:{{brand.secondaryColor}};font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:32px;font-size:15px;line-height:1.6;">{{{body}}}</td></tr>
<tr><td style="padding:24px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.6;color:#64748b;">
<strong style="color:#334155;">{{brand.name}}</strong><br>
{{#if brand.businessAddress}}{{brand.businessAddress}}<br>{{/if}}
Need help? <a href="mailto:{{brand.contactEmail}}" style="color:{{brand.primaryColor}};">{{brand.contactEmail}}</a>{{#if brand.supportPhone}} &middot; {{brand.supportPhone}}{{/if}}{{#if brand.supportUrl}} &middot; <a href="{{brand.supportUrl}}" style="color:{{brand.primaryColor}};">Support centre</a>{{/if}}<br>
<a href="{{brand.siteUrl}}/terms" style="color:#64748b;">Terms</a> &middot; <a href="{{brand.siteUrl}}/refund-policy" style="color:#64748b;">Refund policy</a> &middot; <a href="{{brand.siteUrl}}/privacy" style="color:#64748b;">Privacy</a>
{{#if unsubscribeUrl}}<br><a href="{{unsubscribeUrl}}" style="color:#64748b;">Unsubscribe from {{brand.name}} marketing emails</a>{{/if}}
</td></tr></table></td></tr></table></body></html>`;

const btn = (href: string, label: string) =>
  `<p style="margin:24px 0;"><a href="${href}" style="display:inline-block;background:{{brand.primaryColor}};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;">${label}</a></p>`;

const orderTable = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;">
{{#each items}}<tr><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">{{this.quantity}} &times; {{this.name}}</td><td align="right" style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">{{this.total}}</td></tr>{{/each}}
{{#if fees}}<tr><td style="padding:8px 14px;color:#64748b;">Fees</td><td align="right" style="padding:8px 14px;color:#64748b;">{{fees}}</td></tr>{{/if}}
{{#if tax}}<tr><td style="padding:8px 14px;color:#64748b;">Tax</td><td align="right" style="padding:8px 14px;color:#64748b;">{{tax}}</td></tr>{{/if}}
{{#if discount}}<tr><td style="padding:8px 14px;color:#64748b;">Discount</td><td align="right" style="padding:8px 14px;color:#64748b;">-{{discount}}</td></tr>{{/if}}
<tr><td style="padding:12px 14px;font-weight:700;">Total paid</td><td align="right" style="padding:12px 14px;font-weight:700;">{{total}}</td></tr></table>`;

const eventBlock = `<p style="margin:16px 0;padding:14px 16px;background:#f8fafc;border-left:4px solid {{brand.secondaryColor}};border-radius:4px;">
<strong>{{event.name}}</strong><br>{{event.when}}<br>{{event.venue}}</p>`;

export const DEFAULT_TEMPLATES: Record<NotificationType, { subject: string; bodyHtml: string; sms?: string }> = {
  REGISTRATION_CONFIRMATION: {
    subject: 'Welcome to {{brand.name}}',
    bodyHtml: `<h2 style="margin:0 0 12px;">Welcome, {{name}}</h2><p>Your {{brand.name}} account has been created. You can now buy tickets faster and find all your orders in one place.</p>`,
  },
  EMAIL_VERIFICATION: {
    subject: 'Confirm your email address for {{brand.name}}',
    bodyHtml: `<h2 style="margin:0 0 12px;">Confirm your email</h2><p>Hi {{name}}, please confirm this email address to secure your {{brand.name}} account.</p>${btn('{{verifyUrl}}', 'Confirm email address')}<p style="color:#64748b;font-size:13px;">This link expires in 24 hours. If you did not create an account, you can ignore this email.</p>`,
  },
  PASSWORD_RESET: {
    subject: 'Reset your {{brand.name}} password',
    bodyHtml: `<h2 style="margin:0 0 12px;">Reset your password</h2><p>We received a request to reset the password for your {{brand.name}} account.</p>${btn('{{resetUrl}}', 'Choose a new password')}<p style="color:#64748b;font-size:13px;">This link expires in 1 hour. If you did not request it, no action is needed.</p>`,
  },
  ORDER_CONFIRMATION: {
    subject: 'Order {{orderReference}} confirmed - {{event.name}}',
    bodyHtml: `<h2 style="margin:0 0 12px;">Thank you, {{name}}. Your order is confirmed.</h2><p>Order reference: <strong>{{orderReference}}</strong></p>${eventBlock}${orderTable}<p>Your tickets are being sent in a separate email.</p>${btn('{{orderUrl}}', 'View your order')}<p style="color:#64748b;font-size:13px;">Sold by {{seller}}. This purchase is covered by {{brand.name}}'s terms (v{{policy.terms}}) and refund policy (v{{policy.refund}}).</p>`,
  },
  PAYMENT_CONFIRMATION: {
    subject: 'Payment received for order {{orderReference}}',
    bodyHtml: `<h2 style="margin:0 0 12px;">Payment received</h2><p>We have received your payment of <strong>{{total}}</strong> for order <strong>{{orderReference}}</strong>.</p><p style="color:#64748b;font-size:13px;">Payment reference: {{paymentReference}}<br>Paid on: {{paidAt}}</p>`,
  },
  TICKET_DELIVERY: {
    subject: 'Your tickets for {{event.name}}',
    bodyHtml: `<h2 style="margin:0 0 12px;">Your tickets are here</h2><p>Hi {{name}}, your {{ticketCount}} ticket(s) for order <strong>{{orderReference}}</strong> are attached as PDF files.</p>${eventBlock}<p>Show the QR code on each ticket at the entrance. Each ticket admits one person and can be scanned once.</p>${btn('{{orderUrl}}', 'View tickets online')}`,
    sms: '{{brand.name}}: your {{ticketCount}} ticket(s) for {{event.name}} are confirmed. Ref {{orderReference}}. Tickets sent to {{email}}.',
  },
  EVENT_REMINDER: {
    subject: 'Reminder: {{event.name}} is coming up',
    bodyHtml: `<h2 style="margin:0 0 12px;">See you soon, {{name}}</h2>${eventBlock}<p>Have your ticket QR codes ready at the entrance.</p>${btn('{{orderUrl}}', 'View your tickets')}`,
    sms: '{{brand.name}}: reminder, {{event.name}} is on {{event.when}} at {{event.venue}}.',
  },
  EVENT_POSTPONEMENT: {
    subject: 'New date for {{event.name}}',
    bodyHtml: `<h2 style="margin:0 0 12px;">{{event.name}} has a new date</h2><p>Hi {{name}}, the event you booked has been rescheduled.</p>${eventBlock}<p>Your tickets remain valid for the new date. If you cannot attend, please see our refund policy or contact support.</p>`,
  },
  EVENT_CANCELLATION: {
    subject: '{{event.name}} has been cancelled',
    bodyHtml: `<h2 style="margin:0 0 12px;">{{event.name}} has been cancelled</h2><p>Hi {{name}}, we are sorry to let you know that this event will not take place.</p>{{#if reason}}<p>{{reason}}</p>{{/if}}<p>Refunds are handled under our refund policy. Our support team will contact you about order <strong>{{orderReference}}</strong>, or you can reach us using the details below.</p>`,
  },
  REFUND_CONFIRMATION: {
    subject: 'Refund processed for order {{orderReference}}',
    bodyHtml: `<h2 style="margin:0 0 12px;">Your refund has been processed</h2><p>Hi {{name}}, we have refunded <strong>{{amount}}</strong> for order <strong>{{orderReference}}</strong> to your original payment method.</p><p style="color:#64748b;font-size:13px;">Refund reference: {{refundReference}}. Depending on your bank or mobile money provider it can take several working days to appear.</p>{{#if revokedCount}}<p>{{revokedCount}} ticket(s) on this order are no longer valid.</p>{{/if}}`,
  },
  TICKET_TRANSFER: {
    subject: '{{fromName}} sent you a ticket for {{event.name}}',
    bodyHtml: `<h2 style="margin:0 0 12px;">You have been sent a ticket</h2><p>{{fromName}} wants to transfer a ticket to you.</p>${eventBlock}${btn('{{claimUrl}}', 'Accept ticket')}<p style="color:#64748b;font-size:13px;">This link expires on {{expiresAt}}. Once accepted, the original ticket QR code stops working.</p>`,
  },
  SELLER_NOTIFICATION: {
    subject: '{{title}}',
    bodyHtml: `<h2 style="margin:0 0 12px;">{{title}}</h2><p>{{message}}</p>`,
  },
  SUPPORT_UPDATE: {
    subject: 'Update on your request {{ticketReference}}',
    bodyHtml: `<h2 style="margin:0 0 12px;">We have replied to your request</h2><p>Hi {{name}}, there is an update on <strong>{{ticketReference}}</strong> - {{ticketSubject}}.</p><div style="margin:16px 0;padding:14px 16px;background:#f8fafc;border-radius:8px;white-space:pre-wrap;">{{message}}</div><p>Reply to this email or contact us using the details below.</p>`,
  },
  MARKETING: {
    subject: '{{subject}}',
    bodyHtml: `{{{content}}}`,
  },
};
