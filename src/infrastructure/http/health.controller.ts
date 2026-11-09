import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { DependencyObservability } from '../observability/dependency-observability.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(DependencyObservability) private readonly dependencies: DependencyObservability) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const checks = await this.dependencies.readiness();
    if (!checks.postgres || !checks.sqs) throw new ServiceUnavailableException({ status: 'unavailable', checks });
    return { status: 'ok', checks };
  }
}
