import { Provider, Type } from '@nestjs/common';
import { CampaignService } from '../marketing/campaign.service';
import { MarketingController } from '../marketing/marketing.controller';
import { PublicTrackingController } from '../marketing/public-tracking.controller';
import { NotificationsController } from '../notifications/notifications.controller';
import { ReportsController } from '../reports/reports.controller';
import { MaintenanceService } from './maintenance.service';
import { HealthController, OpsController } from './ops.controller';

/** Marketing, notification administration, reporting and operations. */
export const OPS_CONTROLLERS: Type<unknown>[] = [MarketingController, PublicTrackingController, NotificationsController, ReportsController, HealthController, OpsController];
export const OPS_PROVIDERS: Provider[] = [CampaignService, MaintenanceService];
