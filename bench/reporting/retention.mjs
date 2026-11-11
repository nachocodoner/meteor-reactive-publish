export function retentionSummary(samples) {
  if (samples.length < 2)
    throw new Error('Retention needs a baseline and final checkpoint');
  const first = samples[0];
  const last = samples.at(-1);
  if (
    first.cycle !== 0 ||
    last.cycle <= 0 ||
    samples.some((row, index) => index && row.cycle <= samples[index - 1].cycle)
  )
    throw new Error('Retention checkpoints must have increasing cycle counts');
  const meanX =
    samples.reduce((sum, row) => sum + row.cycle, 0) / samples.length;
  const meanY =
    samples.reduce((sum, row) => sum + row.heapUsed, 0) / samples.length;
  const numerator = samples.reduce(
    (sum, row) => sum + (row.cycle - meanX) * (row.heapUsed - meanY),
    0
  );
  const denominator = samples.reduce(
    (sum, row) => sum + (row.cycle - meanX) ** 2,
    0
  );
  return {
    retention_checkpoints: samples.length,
    retained_heap_growth_bytes: last.heapUsed - first.heapUsed,
    retained_heap_slope_bytes_per_100_cycles: (numerator / denominator) * 100,
    retained_rss_growth_bytes: last.rss - first.rss,
    retained_external_growth_bytes: last.external - first.external,
    retained_array_buffers_growth_bytes: last.arrayBuffers - first.arrayBuffers,
  };
}
