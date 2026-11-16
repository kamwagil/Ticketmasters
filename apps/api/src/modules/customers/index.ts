import { Provider, Type } from '@nestjs/common';
import { SupportController } from '../support/support.controller';
import { CustomersController } from './customers.controller';
import { SegmentService } from './segments';
import { StorefrontCustomerController } from './storefront-customer.controller';

/** Storefront customer/ticket/support APIs, the admin CRM and the admin support desk. */
export const CUSTOMER_CONTROLLERS: Type<unknown>[] = [StorefrontCustomerController, CustomersController, SupportController];
export const CUSTOMER_PROVIDERS: Provider[] = [SegmentService];
