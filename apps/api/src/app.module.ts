import { Module } from '@nestjs/common';
import { CustomerGuard, IdempotencyService, OptionalCustomerGuard, RateLimitGuard, StaffGuard, StorefrontGuard } from './common/auth';
import { InfraModule } from './common/infra';
import { StorageService } from './common/storage';
import { AuthController } from './modules/access/auth.controller';
import { StaffController } from './modules/access/staff.controller';
import { BrandsController, StorefrontBrandController } from './modules/brands/brands.controller';
import { CatalogController } from './modules/catalog/catalog.controller';
import { CatalogService } from './modules/catalog/catalog.service';
import { StorefrontEventsController } from './modules/catalog/storefront-events.controller';
import { CustomerService } from './modules/customers/customer.service';
import { InventoryService } from './modules/inventory/inventory.service';
import { NotificationService } from './modules/notifications/notification.service';
import { OrderService } from './modules/orders/order.service';
import { StorefrontCheckoutController } from './modules/orders/storefront-checkout.controller';
import { LedgerService } from './modules/payments/ledger.service';
import { PaymentService } from './modules/payments/payment.service';
import { PricingService } from './modules/payments/pricing.service';
import { FlutterwaveAdapter, PaystackAdapter, ProviderRegistry, SandboxAdapter } from './modules/payments/providers';
import { RefundService } from './modules/payments/refund.service';
import { SandboxGatewayController, WebhookController } from './modules/payments/webhook.controller';
import { TicketDocumentService } from './modules/tickets/ticket-document.service';
import { TicketService } from './modules/tickets/ticket.service';
import { EXTRA_CONTROLLERS, EXTRA_PROVIDERS } from './modules/registry';

/**
 * Services form a dependency DAG (inventory → orders → payments → refunds ...), so a single
 * flat module keeps wiring simple while the code stays organised by domain folder.
 * Every service is stateless: any number of API and worker replicas can run side by side.
 */
@Module({
  imports: [InfraModule],
  controllers: [
    AuthController, StaffController, BrandsController, StorefrontBrandController, CatalogController, StorefrontEventsController,
    StorefrontCheckoutController, WebhookController, SandboxGatewayController, ...EXTRA_CONTROLLERS,
  ],
  providers: [
    StaffGuard, StorefrontGuard, CustomerGuard, OptionalCustomerGuard, RateLimitGuard, IdempotencyService, StorageService,
    CatalogService, InventoryService, NotificationService, TicketDocumentService, TicketService, CustomerService, OrderService,
    PricingService, LedgerService, PaystackAdapter, FlutterwaveAdapter, SandboxAdapter, ProviderRegistry, PaymentService, RefundService,
    ...EXTRA_PROVIDERS,
  ],
})
export class AppModule {}
