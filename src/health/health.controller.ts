import { Controller, Get } from '@nestjs/common';

import { HealthService, type HealthStatus } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  live(): HealthStatus {
    return this.healthService.getLiveness();
  }

  @Get('ready')
  ready(): Promise<HealthStatus> {
    return this.healthService.getReadiness();
  }
}
