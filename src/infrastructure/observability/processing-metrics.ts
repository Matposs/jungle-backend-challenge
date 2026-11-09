const components = ['http', 'sqs', 'outbox', 'references'] as const;
type Component = typeof components[number];
type Counter = 'duplicates' | 'retries' | 'lockConflicts';

export class ProcessingMetrics {
  readonly #samples = new Map(components.map((component) => [
    component, { duplicates: 0, retries: 0, lockConflicts: 0, count: 0, seconds: 0 },
  ]));

  increment(counter: Counter, component: Component): void {
    this.#samples.get(component)![counter]++;
  }

  recordLockConflict(component: Component, error: unknown): void {
    if (error instanceof Error && 'code' in error && (error.code === '40P01' || error.code === '55P03')) {
      this.increment('lockConflicts', component);
    }
  }

  observe(component: Component, startedAt: number): void {
    const sample = this.#samples.get(component)!;
    sample.count++;
    sample.seconds += (performance.now() - startedAt) / 1000;
  }

  render(): string {
    const counters = [
      ['duplicates', 'wager_duplicates_total', 'Detected idempotent replays and Inbox duplicates.'],
      ['retries', 'processing_retries_total', 'Retry decisions by processing component.'],
      ['lockConflicts', 'postgres_lock_conflicts_total', 'Detected PostgreSQL deadlocks and lock acquisition failures.'],
    ] as const;
    const lines = counters.flatMap(([key, metric, help]) => [
      `# HELP ${metric} ${help}`,
      `# TYPE ${metric} counter`,
      ...Array.from(this.#samples, ([component, sample]) => `${metric}{component="${component}"} ${sample[key]}`),
    ]);
    lines.push(
      '# HELP processing_duration_seconds Processing attempt duration in seconds.',
      '# TYPE processing_duration_seconds summary',
      ...Array.from(this.#samples, ([component, sample]) => [
        `processing_duration_seconds_count{component="${component}"} ${sample.count}`,
        `processing_duration_seconds_sum{component="${component}"} ${sample.seconds}`,
      ]).flat(),
    );
    return `${lines.join('\n')}\n`;
  }
}

export const processingMetrics = new ProcessingMetrics();
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export function startProcessingMetrics(defaultPort: number) {
  const port = Number(process.env.METRICS_PORT ?? defaultPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid metrics port.');
  return Bun.serve({
    hostname: process.env.METRICS_HOST ?? '127.0.0.1',
    port,
    fetch(request) {
      if (request.method !== 'GET' || new URL(request.url).pathname !== '/metrics') {
        return new Response(null, { status: 404 });
      }
      return new Response(processingMetrics.render(), { headers: { 'Content-Type': METRICS_CONTENT_TYPE } });
    },
  });
}
