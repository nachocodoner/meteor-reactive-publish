export function lifecycleErrors(result) {
  if (!result.config?.lifecycle) return [];
  const errors = [];
  const probe = result.phases?.lifecycleProbe;
  const initial = result.phases?.initial?.server?.lifecycle;
  const measured = result.metrics?.lifecycle;
  const cleanup = result.phases?.cleanup?.end?.lifecycle;
  if (!/^instrumentation@0\.0\.1$/m.test(result.metadata?.packages || ''))
    errors.push('Missing pinned Meteor instrumentation package');
  for (const [phase, snapshot] of Object.entries({
    probe,
    measured,
    cleanup,
  })) {
    if (snapshot?.version !== 1) {
      errors.push(`Missing lifecycle coverage: ${phase}`);
      continue;
    }
    if (
      !snapshot.faults ||
      ['listenerErrors', 'overflow', 'unmatched', 'invalidDurations'].some(
        (key) => snapshot.faults[key] !== 0
      )
    )
      errors.push(`Lifecycle collector lost coverage: ${phase}`);
    if (snapshot.pendingMethods !== 0)
      errors.push(`Lifecycle methods still pending: ${phase}`);
  }
  const check = probe?.methods?.['bench.lifecycleProbe'];
  if (
    check?.started !== 2 ||
    check.succeeded !== 1 ||
    check.failed !== 1 ||
    check.duration?.count !== 2
  )
    errors.push(
      'Meteor method lifecycle probe did not observe success and failure'
    );
  if (result.config.level !== 'ddp') return errors;
  if (
    initial?.publication?.started !== result.config.profile.clients ||
    initial.publication.ready !== result.config.profile.clients ||
    initial.publication.readiness?.count !== result.config.profile.clients
  )
    errors.push('Missing initial publication lifecycle coverage');
  if (initial?.connections?.active !== result.config.profile.clients + 1)
    errors.push('Missing DDP connection lifecycle coverage');
  const churnStarts =
    result.config.scenario === 'subscription-churn'
      ? result.config.profile.clients * result.config.profile.operations
      : 0;
  if (
    measured?.publication?.started !== churnStarts ||
    measured.publication.ready !== churnStarts ||
    measured.publication.readiness?.count !== churnStarts ||
    measured.publication.stopped !== churnStarts ||
    measured.publication.failed !== 0 ||
    measured.publication.active !== result.config.profile.clients
  )
    errors.push('Missing measured publication lifecycle coverage');
  const calls = Object.values(measured?.methods || {});
  const expected = result.metrics?.method_roundtrip_ms?.count;
  if (
    calls.reduce((sum, stat) => sum + stat.started, 0) !== expected ||
    calls.reduce((sum, stat) => sum + stat.succeeded, 0) !== expected ||
    calls.some((stat) => stat.failed !== 0) ||
    measured?.methodDuration?.count !== expected
  )
    errors.push('Missing measured method lifecycle coverage');
  if (cleanup?.publication?.active !== 0 || cleanup.publication.failed !== 0)
    errors.push('Benchmark publication lifecycle did not stop cleanly');
  const stops =
    result.config.profile.clients *
    (result.config.scenario === 'subscription-churn'
      ? result.config.profile.operations + 1
      : 1);
  if (cleanup?.publication?.stopped !== stops)
    errors.push('Missing publication stop lifecycle coverage');
  return errors;
}

const number = (value) =>
  value == null ? 'n/a' : Number(value.toFixed(3)).toLocaleString('en-US');
export function lifecycleMarkdown(result) {
  if (!result.config?.lifecycle) return '';
  const snapshots = [
    ['Initial subscriptions', result.phases?.initial?.server?.lifecycle],
    [
      'Measured workload',
      result.metrics?.lifecycle || result.phases?.failure?.lifecycle,
    ],
    ['After unsubscribe', result.phases?.cleanup?.end?.lifecycle],
  ];
  const rows = [];
  for (const [phase, snapshot] of snapshots) {
    if (!snapshot) continue;
    for (const [name, stat] of Object.entries(snapshot.methods)) {
      if (!stat.started && !stat.succeeded && !stat.failed) continue;
      rows.push(
        `| ${phase}: ${name} | ${stat.started} | ${stat.succeeded} | ${stat.failed} | ${number(stat.duration.mean)} | ${number(stat.duration.p95)} | ${stat.duration.sample_count}/${stat.duration.count}${stat.duration.truncated ? ' (capped; percentiles unavailable)' : ''} |`
      );
    }
  }
  const initial = snapshots[0][1];
  const cleanup = snapshots[2][1];
  return (
    '\n\nMeteor lifecycle diagnostics (optional; server wall-clock milliseconds).\n\n' +
    '| Phase / method | Started | Completed | Errors | Mean ms | p95 ms | Timing samples / total |\n| --- | ---: | ---: | ---: | ---: | ---: | --- |\n' +
    rows.join('\n') +
    '\n\n' +
    `Initial publication readiness: ${number(initial?.publication?.readiness?.p95)} ms p95, ${initial?.publication?.ready ?? 'n/a'} ready events. ` +
    `Publication stops: ${cleanup?.publication?.stopped ?? 'n/a'}; active after unsubscribe: ${cleanup?.publication?.active ?? 'n/a'}.\n\n` +
    'Method duration excludes waiting before dispatch and client delivery. Publication stop is a lifecycle event, not proof that cleanup finished; observer checks remain separate. Counts include every observed event; capped timing storage never hides errors. p95 needs 20 samples, p99 needs 1,000.\n'
  );
}
