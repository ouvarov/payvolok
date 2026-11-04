import { Controller, Get } from '@nestjs/common';

import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return this.healthService.getLiveness();
  }

  @Get('ready')
  ready(): Promise<{ status: 'ok' }> {
    return this.healthService.getReadiness();
  }
}
