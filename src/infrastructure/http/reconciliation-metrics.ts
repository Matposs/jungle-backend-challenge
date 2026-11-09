import { Controller, Get, Header, Inject, Injectable, Optional } from '@nestjs/common';
import { DependencyObservability } from '../observability/dependency-observability.js';
import { METRICS_CONTENT_TYPE } from '../observability/processing-metrics.js';

const METRIC = 'wallet_reconciliation_divergences_total';

@Injectable()
export class ReconciliationMetrics {
  #divergences = 0n;

  recordDivergence(walletId: string, checkedEntries: number): void {
    this.#divergences += 1n;
    console.warn(JSON.stringify({
      event: 'wallet_reconciliation_divergence', correlationId: crypto.randomUUID(), walletId, checkedEntries,
    }));
  }

  render(): string {
    return [
      `# HELP ${METRIC} Wallet reconciliation checks that found a balance divergence.`,
      `# TYPE ${METRIC} counter`,
      `${METRIC} ${this.#divergences}`,
      '',
    ].join('\n');
  }
}

@Controller('metrics')
export class ReconciliationMetricsController {
  constructor(
    @Inject(ReconciliationMetrics) private readonly metrics: ReconciliationMetrics,
    @Optional() @Inject(DependencyObservability) private readonly dependencies?: DependencyObservability,
  ) {}

  @Get()
  @Header('Content-Type', METRICS_CONTENT_TYPE)
  async metricsText(): Promise<string> {
    const additional = await this.dependencies?.renderMetrics() ?? '';
    return this.metrics.render() + additional;
  }
}
