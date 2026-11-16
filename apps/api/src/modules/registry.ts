import { Provider, Type } from '@nestjs/common';
import { CUSTOMER_CONTROLLERS, CUSTOMER_PROVIDERS } from './customers';
import { OPS_CONTROLLERS, OPS_PROVIDERS } from './ops';
import { OrdersController } from './orders/orders.controller';
import { FinanceController } from './payments/finance.controller';
import { FinanceService } from './payments/finance.service';
import { ScannerController, TicketsController } from './tickets/tickets.controller';

/** Controllers and providers of the administration, CRM and operations modules. */
export const EXTRA_CONTROLLERS: Type<unknown>[] = [OrdersController, FinanceController, TicketsController, ScannerController, ...CUSTOMER_CONTROLLERS, ...OPS_CONTROLLERS];
export const EXTRA_PROVIDERS: Provider[] = [FinanceService, ...CUSTOMER_PROVIDERS, ...OPS_PROVIDERS];
