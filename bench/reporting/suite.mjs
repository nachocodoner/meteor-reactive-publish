import { comparisonMarkdown } from './results.mjs';

export function suiteTotals(report) {
  const variants = report.cases.flatMap((entry) =>
    Object.values(entry.adapters)
  );
  const runs = variants.flatMap((variant) => variant.runs);
  const comparisons = report.cases.flatMap((entry) => entry.comparisons);
  return {
    ddpScenarios: report.cases.filter((entry) => entry.level === 'ddp').length,
    plannedVariants: variants.filter((variant) => variant.status !== 'skipped')
      .length,
    validVariants: variants.filter((variant) => variant.status === 'valid')
      .length,
    invalidVariants: variants.filter((variant) => variant.status === 'invalid')
      .length,
    skippedVariants: variants.filter((variant) => variant.status === 'skipped')
      .length,
    attemptedRuns: runs.length,
    validRuns: runs.filter((run) => run.status === 'valid').length,
    invalidRuns: runs.filter((run) => run.status === 'invalid').length,
    compared: comparisons.filter(
      (comparison) => comparison.status === 'compared'
    ).length,
    blocked: comparisons.filter((comparison) => comparison.status === 'blocked')
      .length,
  };
}

const format = (value) =>
  Number.isFinite(value)
    ? Number(value.toFixed(3)).toLocaleString('en-US')
    : 'n/a';
const escapeMarkdown = (value) =>
  String(value).replaceAll('\n', ' ').replaceAll('|', '\\|');
const meanMetric = (variant, metric) => {
  if (variant.status !== 'valid') return null;
  const values = variant.runs.map((run) =>
    metric.split('.').reduce((value, part) => value?.[part], run.metrics)
  );
  return values.length && values.every(Number.isFinite)
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
};
const metricColumns = [
  ['Ready p95 ms', 'subscription_ready_ms.p95'],
  ['Update p95 ms', 'update_convergence_ms.p95'],
  ['CPU ms/op', 'cpu_ms_per_operation'],
  ['Peak RSS bytes', 'app_rss_bytes'],
  ['DDP bytes/op', 'bytes_per_operation'],
];
const variantRows = (entry) =>
  Object.entries(entry.adapters).map(([adapter, variant]) => [
    adapter,
    variant.status,
    `${variant.runs.filter((run) => run.status === 'valid').length}/${variant.runs.length}`,
    ...metricColumns.map(([, metric]) => format(meanMetric(variant, metric))),
  ]);
const variantHeaders = [
  'Adapter',
  'Status',
  'Valid/attempted',
  ...metricColumns.map(([label]) => label),
];
const summaryRows = (report) =>
  report.cases.map((entry) => [
    entry.id,
    entry.level,
    entry.status,
    Object.entries(entry.adapters)
      .map(([name, variant]) => `${name}: ${variant.status}`)
      .join('; '),
    entry.comparisons.length
      ? entry.comparisons
          .map(
            (comparison) =>
              `${comparison.baseline} → ${comparison.target}: ${comparison.status}`
          )
          .join('; ')
      : 'No equivalent cross-library comparison',
  ]);
const description = (report) =>
  `Meteor ${report.config.meteor}; publish-composite ${report.compositeVersion}; ${report.requestedPairs} repetition(s) per variant; ${report.config.profile.clients} clients; ${report.config.profile.parents} parents; ${report.config.profile.operations} ${report.config.comprehensive ? 'core-stage ' : ''}measured operations per run; seed ${report.config.seed}.`;
const metricNote =
  'Values are means of independent per-run summaries, including percentiles (not pooled percentiles). At least five paired runs are needed for statistical comparisons; p95 needs 20 observations per run and p99 needs 1,000. Invalid/incomplete variants have no performance ranking. Comparisons and practical budgets remain advisory. Positive changes mean the metric increased: lower costs and higher throughput are preferable; utilization is contextual. Intervals are approximate 95% paired-bootstrap target-minus-baseline delta intervals. No universal library score is assigned.';
const title = (report) =>
  report.config.comprehensive
    ? 'Comprehensive library comparison'
    : 'Full benchmark report';
const caseSettings = (entry) =>
  entry.run
    ? `${entry.stage}: ${entry.run.profile.operations} operations, ${entry.run.profile.warmup} warmup operations, ${entry.run.profile.clients} clients. ${entry.stage === 'queries' ? 'Mongo profiling enabled: diagnostic costs are separate from core measurements.' : entry.stage === 'retention' ? 'Stable fixture; all subscriptions removed and resources verified before forced-GC checkpoints. Growth is evidence to investigate, not proof of a leak.' : entry.stage === 'load' ? `Offered ${entry.run.rate} writes/s; at least ${entry.run.duration}s. Budget: ${entry.run.loadSloMs} ms scheduled-delivery p95. Generator utilization >=90% cannot establish server capacity.` : 'Normal GC; database profiling disabled.'}`
    : '';

function generatorNote(entry) {
  const samples = Object.values(entry.adapters).flatMap((variant) =>
    variant.runs
      .map((run) => run.generator?.utilization)
      .filter(Number.isFinite)
  );
  return samples.length
    ? `Load-generator utilization: up to ${format(Math.max(...samples) * 100)}%. ${Math.max(...samples) >= 0.9 ? 'Generator is busy; client-observed latency and throughput may be limited by the harness.' : 'No >=90% generator utilization observed.'}`
    : '';
}

export function loadRows(report) {
  return report.cases
    .filter((entry) => entry.stage === 'load')
    .flatMap((entry) =>
      Object.entries(entry.adapters).map(([adapter, variant]) => {
        const valid = variant.status === 'valid';
        const limited = variant.runs.some((run) => run.load?.generator_limited);
        const met =
          valid &&
          variant.runs.every((run) => run.load?.within_latency_budget === true);
        return [
          entry.run.rate,
          adapter,
          format(meanMetric(variant, 'completed_operations_per_second')),
          format(meanMetric(variant, 'scheduled_convergence_ms.p95')),
          format(meanMetric(variant, 'cpu_ms_per_operation')),
          !valid
            ? variant.status
            : limited
              ? 'Generator limited'
              : !met
                ? 'Exceeded latency budget'
                : report.requestedPairs < 5
                  ? 'Budget met; insufficient repetitions'
                  : 'Budget met in every repetition',
        ];
      })
    );
}
const loadHeaders = [
  'Offered writes/s',
  'Library',
  'Completed ops/s',
  'Scheduled p95 ms',
  'CPU ms/op',
  'Evidence',
];
const failureHeaders = [
  'Failed attempt',
  'Completed/requested',
  'Server CPU ms',
  'RSS MiB',
  'Event-loop p99 ms',
  'Generator busy %',
  'Schedule lag p95 ms',
  'Phase',
];
const failureRows = (entry) =>
  Object.entries(entry.adapters).flatMap(([adapter, variant]) =>
    variant.runs
      .filter((run) => run.status === 'invalid' && run.failureProgress)
      .map((run) => [
        `${adapter} / ${run.pair + 1}`,
        `${format(run.failureProgress.completed)}/${format(run.failureProgress.requested)}`,
        format(run.failure?.app_cpu_ms),
        format(run.failure?.app_rss_bytes / 1024 / 1024),
        format(run.failure?.event_loop_p99_ms),
        format(run.generator?.utilization * 100),
        format(run.generator?.scheduling_lag_ms?.p95),
        run.failureProgress.phase,
      ])
  );
const totalsText = (report) =>
  `${report.totals.ddpScenarios} DDP scenarios; ${report.totals.validVariants}/${report.totals.plannedVariants} variants valid; ${report.totals.validRuns}/${report.totals.attemptedRuns} runs valid; ${report.totals.compared} comparisons available; ${report.totals.blocked} comparisons blocked; ${report.totals.skippedVariants} optional checks skipped.`;
const markdownTable = (headers, rows) =>
  `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((row) => `| ${row.map(escapeMarkdown).join(' | ')} |`).join('\n')}\n`;

function diagnosticRows(entry) {
  if (!['backend', 'browser'].includes(entry.level)) return [];
  const variant = entry.adapters.reactive;
  if (variant.status !== 'valid') return [];
  const names =
    entry.level === 'browser'
      ? ['browser_data_ms']
      : Object.keys(variant.runs[0].metrics.backend).map(
          (name) => `backend.${name}`
        );
  return names.map((name) => [
    name,
    format(meanMetric(variant, `${name}.mean`)),
    format(meanMetric(variant, `${name}.p95`)),
  ]);
}

export function suiteMarkdown(report) {
  const parts = [
    `# ${title(report)}`,
    '',
    `Status: **${report.status}**.`,
    '',
    description(report),
    '',
    totalsText(report),
    '',
    metricNote,
    '',
    markdownTable(
      ['Case', 'Level', 'Status', 'Variants', 'Comparisons'],
      summaryRows(report)
    ),
  ];
  if (report.config.comprehensive)
    parts.push(
      report.config.comprehensive.note,
      '',
      `Preset: ${report.config.comprehensive.preset}. Stages: ${report.config.comprehensive.stages.join(', ')}.`,
      ''
    );
  if (loadRows(report).length)
    parts.push(
      '## Offered-load results',
      '',
      'These are tested load points, not a claim of maximum capacity. The same fixture, rate, count and duration apply to both libraries.',
      '',
      markdownTable(loadHeaders, loadRows(report)),
      ''
    );
  for (const entry of report.cases) {
    parts.push(`## ${entry.id}`, '', entry.description, '');
    if (entry.run) parts.push(caseSettings(entry), '');
    if (generatorNote(entry)) parts.push(generatorNote(entry), '');
    if (!entry.enabled) {
      parts.push(entry.skipReason, '');
      continue;
    }
    parts.push(markdownTable(variantHeaders, variantRows(entry)));
    if (failureRows(entry).length)
      parts.push(
        'Partial failed-run diagnostics; excluded from performance comparisons.',
        '',
        markdownTable(failureHeaders, failureRows(entry)),
        ''
      );
    const diagnostics = diagnosticRows(entry);
    if (diagnostics.length)
      parts.push(
        markdownTable(['Diagnostic', 'Mean ms', 'p95 ms'], diagnostics)
      );
    for (const [adapter, variant] of Object.entries(entry.adapters)) {
      parts.push(
        `${adapter}: ${variant.runs.map((run) => (run.path ? `[run ${run.pair + 1}](${run.path})` : `run ${run.pair + 1}: no artifact`)).join(', ') || 'not run'}.`,
        ''
      );
      for (const error of variant.errors)
        parts.push(`- ${adapter}: ${escapeMarkdown(error)}`);
      if (variant.errors.length) parts.push('');
    }
    for (const comparison of entry.comparisons) {
      parts.push(`### ${comparison.baseline} → ${comparison.target}`, '');
      parts.push(
        comparison.report
          ? comparisonMarkdown(comparison.report, {
              baselineLabel: comparison.baseline,
              targetLabel: comparison.target,
            })
          : `Blocked: ${comparison.reason}`,
        ''
      );
    }
  }
  return parts.join('\n');
}

const html = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const htmlTable = (headers, rows) =>
  `<div class="scroll"><table><thead><tr>${headers.map((header) => `<th>${html(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${html(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

function lineChart(series, xLabel, yLabel) {
  const points = series.flatMap((entry) => entry.points);
  if (!points.length) return '';
  const maxX = Math.max(1, ...points.map(([x]) => x));
  const minY = Math.min(0, ...points.map(([, y]) => y));
  const maxY = Math.max(1, ...points.map(([, y]) => y));
  const x = (value) => 70 + (value / maxX) * 580;
  const y = (value) => 210 - ((value - minY) / (maxY - minY)) * 155;
  return `<svg viewBox="0 0 700 265" role="img" aria-label="${html(`${yLabel} by ${xLabel}`)}" style="max-width:800px;width:100%;background:#fff"><path d="M70 50V210H660" fill="none" stroke="#8895aa"/><text x="12" y="35" font-size="12">${html(yLabel)}</text><text x="300" y="252" font-size="12">${html(xLabel)}</text><text x="10" y="65" font-size="11">${format(maxY)}</text><text x="10" y="210" font-size="11">${format(minY)}</text>${series
    .map((entry, index) => {
      const color = ['#1857bd', '#ad4b18'][index % 2];
      return `<text x="${340 + index * 160}" y="28" fill="${color}" font-size="12">${html(entry.name)}</text><polyline points="${entry.points.map(([a, b]) => `${x(a)},${y(b)}`).join(' ')}" stroke="${color}" stroke-width="2" fill="none"/>${entry.points.map(([a, b]) => `<circle cx="${x(a)}" cy="${y(b)}" r="4" fill="${color}"><title>${html(entry.name)}: ${format(a)} / ${format(b)}</title></circle><text x="${x(a)}" y="229" text-anchor="middle" font-size="10">${format(a)}</text>`).join('')}`;
    })
    .join('')}</svg>`;
}

function retentionChart(entry) {
  if (entry.stage !== 'retention' || entry.status !== 'valid') return '';
  const series = Object.entries(entry.adapters).map(([name, variant]) => ({
    name,
    points: (variant.runs[0].retention || []).map((sample, index) => [
      sample.cycle,
      variant.runs.reduce(
        (sum, run) =>
          sum + (run.retention[index].heapUsed - run.retention[0].heapUsed),
        0
      ) /
        variant.runs.length /
        1024 /
        1024,
    ]),
  }));
  return lineChart(
    series,
    'Subscribe/unsubscribe cycles',
    'Post-GC heap growth (MiB; mean across runs)'
  );
}

function loadChart(report) {
  const cases = report.cases.filter(
    (entry) => entry.stage === 'load' && entry.status === 'valid'
  );
  return lineChart(
    ['composite', 'reactive'].map((name) => ({
      name,
      points: cases
        .map((entry) => [
          entry.run.rate,
          meanMetric(entry.adapters[name], 'scheduled_convergence_ms.p95'),
        ])
        .filter(([, value]) => Number.isFinite(value)),
    })),
    'Offered writes/s',
    'Scheduled update p95 (ms; mean across runs)'
  );
}

export function suiteHtml(report) {
  const sections = report.cases
    .map((entry) => {
      const diagnostics = diagnosticRows(entry);
      const variants = Object.entries(entry.adapters)
        .map(
          ([adapter, variant]) =>
            `<p>${html(adapter)}: ${variant.runs.map((run) => (run.path ? `<a href="${html(run.path)}">run ${run.pair + 1}</a>` : `run ${run.pair + 1}: no artifact`)).join(', ') || 'not run'}</p>${variant.errors.length ? `<ul class="errors">${variant.errors.map((error) => `<li>${html(error)}</li>`).join('')}</ul>` : ''}`
        )
        .join('');
      const comparisons = entry.comparisons
        .map(
          (comparison) =>
            `<h3>${html(comparison.baseline)} → ${html(comparison.target)}</h3>${
              comparison.report
                ? htmlTable(
                    [
                      'Metric',
                      comparison.baseline,
                      comparison.target,
                      'Change %',
                      'Evidence',
                      'Reason / paired delta interval',
                    ],
                    comparison.report.details.map((metric) => [
                      `${metric.metric}${metric.unit ? ` (${metric.unit})` : ''}`,
                      format(metric.baseline),
                      format(metric.target),
                      format(metric.percent),
                      metric.effect || metric.status,
                      metric.reason || metric.interval.map(format).join(' to '),
                    ])
                  )
                : `<p class="errors">Blocked: ${html(comparison.reason)}</p>`
            }`
        )
        .join('');
      return `<details data-case="${html(entry.id)}" data-status="${html(entry.status)}"><summary>${html(entry.id)} <span class="badge ${html(entry.status)}">${html(entry.status)}</span></summary><p>${html(entry.description)}</p><p>${html(caseSettings(entry))}</p><p>${html(generatorNote(entry))}</p>${entry.enabled ? htmlTable(variantHeaders, variantRows(entry)) + (failureRows(entry).length ? `<p>Partial failed-run diagnostics; excluded from performance comparisons.</p>${htmlTable(failureHeaders, failureRows(entry))}` : '') + retentionChart(entry) + (diagnostics.length ? htmlTable(['Diagnostic', 'Mean ms', 'p95 ms'], diagnostics) : '') + variants + comparisons : `<p>${html(entry.skipReason)}</p>`}</details>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title(report)}</title>
<style>body{font:15px/1.55 system-ui,sans-serif;color:#172033;background:#f5f7fb;margin:0}main{max-width:1250px;margin:auto;padding:28px}h1{margin-bottom:8px}a{color:#1857bd}p{max-width:1000px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px;background:white;margin:12px 0}th,td{padding:9px 12px;border-bottom:1px solid #dce1e9;text-align:left;vertical-align:top}th{background:#e8eef8}details{background:white;border:1px solid #dce1e9;border-radius:8px;margin:12px 0;padding:16px}summary{cursor:pointer;font-weight:650}.badge{font-size:12px;padding:3px 9px;border-radius:20px;background:#eef1f6;margin-left:8px}.valid{background:#ddf4e5;color:#145b2d}.invalid{background:#ffe5e5;color:#9f2626}.errors{color:#9f2626;overflow-wrap:anywhere}input,select,button{font:inherit;padding:8px;margin:5px 8px 5px 0;border:1px solid #b8c3d4;border-radius:5px;background:white}.notice{border-left:4px solid #4270b4;padding:8px 16px;background:#edf2fa}[hidden]{display:none!important}@media print{.controls{display:none}main{padding:0}}</style></head>
<body><main><h1>${title(report)}</h1><p>Status: <strong>${html(report.status)}</strong> · ${html(report.createdAt)}</p><p>${html(description(report))}</p><p class="notice">${html(totalsText(report))}</p><p>${html(metricNote)}</p>${report.config.comprehensive ? `<p>${html(report.config.comprehensive.note)}</p><p>Preset: ${html(report.config.comprehensive.preset)}. Stages: ${html(report.config.comprehensive.stages.join(', '))}.</p>` : ''}<p><a href="report.md">Markdown report</a> · <a href="report.json">Machine-readable report</a></p>
${loadRows(report).length ? `<h2>Offered-load results</h2><p>Tested load points, not a claim of maximum capacity. Hover over points for values.</p>${loadChart(report)}${htmlTable(loadHeaders, loadRows(report))}` : ''}
${htmlTable(['Case', 'Level', 'Status', 'Variants', 'Comparisons'], summaryRows(report))}
<div class="controls"><label>Find a case <input id="search" type="search" placeholder="Scenario name"></label><label>Status <select id="status"><option value="">All</option><option value="invalid">Failures</option><option value="valid">Valid</option><option value="skipped">Skipped</option><option value="not-run">Not run</option></select></label><button id="expand" type="button">Expand visible cases</button></div>
${sections}</main><script>
const cases = [...document.querySelectorAll('details[data-case]')];
const search = document.getElementById('search'); const status = document.getElementById('status');
function filter() { for (const entry of cases) entry.hidden = !entry.dataset.case.includes(search.value.toLowerCase()) || !!status.value && entry.dataset.status !== status.value; }
search.addEventListener('input', filter); status.addEventListener('change', filter);
document.getElementById('expand').addEventListener('click', () => { for (const entry of cases) if (!entry.hidden) entry.open = true; });
</script></body></html>\n`;
}
