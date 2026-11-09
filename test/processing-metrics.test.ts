import { expect, test } from 'bun:test';
import { processingMetrics, startProcessingMetrics } from '../src/infrastructure/observability/processing-metrics.js';

test('exposes process counters and latency on the worker metrics listener', async () => {
  const previousPort = process.env.METRICS_PORT;
  const previousHost = process.env.METRICS_HOST;
  let server: ReturnType<typeof startProcessingMetrics> | undefined;
  try {
    process.env.METRICS_PORT = '0';
    process.env.METRICS_HOST = '127.0.0.1';
    server = startProcessingMetrics(9467);
    processingMetrics.increment('retries', 'references');
    processingMetrics.observe('references', performance.now() - 1);

    const response = await fetch(new URL('/metrics', server.url));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const body = await response.text();
    expect(body).toContain('processing_retries_total{component="references"}');
    expect(body).toContain('processing_duration_seconds_count{component="references"}');
    expect((await fetch(new URL('/health/live', server.url))).status).toBe(404);
  } finally {
    if (previousPort === undefined) delete process.env.METRICS_PORT;
    else process.env.METRICS_PORT = previousPort;
    if (previousHost === undefined) delete process.env.METRICS_HOST;
    else process.env.METRICS_HOST = previousHost;
    await server?.stop(true);
  }
});
