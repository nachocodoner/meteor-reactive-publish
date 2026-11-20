import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const metrics = [
  'update_convergence_ms.p95',
  'update_convergence_ms.p99',
  'cpu_ms_per_operation',
  'app_rss_bytes',
  'app_heap_used_bytes',
  'gc_ms_per_operation',
  'event_loop_p95_ms',
  'event_loop_p99_ms',
  'completed_operations_per_second',
  'bytes_per_operation',
  'observers_created_per_operation',
  'mongo_cpu_ms_per_operation',
  'mongo_rss_bytes',
];
const get = (object, key) =>
  key.split('.').reduce((value, part) => value?.[part], object);
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
async function optional(file) {
  try {
    return await read(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ]
  );
const escapeMarkdown = (value) =>
  String(value)
    .replaceAll('\n', ' ')
    .replaceAll('|', '\\|')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const format = (value, divisor = 1) =>
  Number.isFinite(value)
    ? (value / divisor).toLocaleString('en-US', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      })
    : 'n/a';
function statistics(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    mean,
    min: Math.min(...values),
    max: Math.max(...values),
    sd:
      values.length > 1
        ? Math.sqrt(
            values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
              (values.length - 1)
          )
        : null,
  };
}

// Read only recorded evidence. Re-reporting never resolves or starts Meteor.
export async function collectExperiment(directory) {
  const plan = await read(path.join(directory, 'plan.json'));
  const execution = await read(path.join(directory, 'execution.json'));
  const rows = [],
    comparisons = [],
    specific = [],
    errors = [],
    allRuns = [];
  const add = (run, relative, scenario, adapter) => {
    run._path = relative;
    allRuns.push(run);
    if (run.status !== 'valid')
      errors.push({
        scenario,
        adapter,
        path: relative,
        errors: run.correctness?.errors || ['Invalid run'],
      });
    return run;
  };
  for (const scenario of plan.comparisonScenarios) {
    const relative = `comparisons/${scenario}`;
    const report = await optional(
      path.join(directory, relative, 'report.json')
    );
    if (!report) continue;
    const entry = report.cases[0];
    comparisons.push({
      scenario,
      status: report.status,
      comparisons: entry.comparisons,
      report: `${relative}/report.html`,
    });
    for (const [adapter, variant] of Object.entries(entry.adapters)) {
      const runs = [];
      for (const record of variant.runs) {
        if (!record.path) continue;
        const file = `${relative}/${record.path}`;
        const run = add(
          await read(path.join(directory, file)),
          file,
          scenario,
          adapter
        );
        if (run.status === 'valid') runs.push(run);
      }
      const row = {
        scenario,
        adapter,
        validRuns: runs.length,
        attemptedRuns: variant.runs.length,
        status: variant.status,
        metrics: {},
      };
      // Do not summarize a selected subset of a failed/incomplete repetition set.
      if (variant.status === 'valid' && runs.length === plan.pairs) {
        for (const metric of metrics) {
          const values = runs.map((run) => get(run.metrics, metric));
          if (values.every(Number.isFinite))
            row.metrics[metric] = statistics(values);
        }
      }
      const utilization = runs
        .map((run) => run.phases?.generator?.utilization)
        .filter(Number.isFinite);
      row.generatorUtilizationMax = utilization.length
        ? Math.max(...utilization)
        : null;
      rows.push(row);
    }
  }
  for (const scenario of [...plan.reactiveSpecificScenarios, 'backend']) {
    const relative = `reactive-only/${scenario}.json`;
    const run = await optional(path.join(directory, relative));
    if (!run) continue;
    add(run, relative, scenario, 'reactive');
    specific.push({
      scenario,
      status: run.status,
      path: relative,
      metrics: run.metrics,
      errors: run.correctness?.errors || [],
    });
  }
  const coordinates = Object.fromEntries(
    ['meteor', 'node', 'mongo', 'harness', 'sourceHash'].map((key) => [
      key,
      new Set(),
    ])
  );
  for (const run of allRuns) {
    const metadata = run.metadata || {};
    for (const key of ['meteor', 'node', 'mongo', 'harness'])
      if (metadata[key]) coordinates[key].add(metadata[key]);
    if (metadata.source) coordinates.sourceHash.add(metadata.source.hash);
    if (run.status !== 'valid') continue;
    const require = (condition, message) =>
      assert.ok(condition, `${run._path}: ${message}`);
    if (plan.meteorCli)
      assert.deepEqual(
        metadata.meteorRuntime,
        plan.identities.runtime,
        `${run._path}: Meteor checkout differs`
      );
    else require(metadata.meteor === plan.meteor, 'Meteor release differs');
    require(metadata.harness === plan.identities.harness, 'Harness differs');
    require(metadata.source?.hash ===
      plan.identities.source.hash, 'Package source differs');
    require(run.metrics.completed_operations ===
      plan.operations, 'Operation count differs');
    require(run.phases?.cleanup?.verified, 'Cleanup not verified');
  }
  return {
    plan,
    coordinates: Object.fromEntries(
      Object.entries(coordinates).map(([key, values]) => [
        key,
        [...values].sort(),
      ])
    ),
    comparisonRows: rows,
    comparisons,
    reactiveSpecific: specific,
    errors,
    totalRuns: allRuns.length,
    validRuns: allRuns.filter((run) => run.status === 'valid').length,
    execution: {
      status: execution.status,
      reason: execution.reason || null,
      hostSamplingError: execution.hostSamplingError || null,
      completedJobs: execution.jobs.filter((job) => job.status === 'complete')
        .length,
      plannedJobs: execution.jobs.length,
      jobs: execution.jobs.map(({ id, status, error }) => ({
        id,
        status,
        ...(error ? { error } : {}),
      })),
    },
  };
}

function reportSections(summary) {
  const { plan, comparisonRows: rows } = summary;
  const main = [],
    resources = [],
    evidence = [];
  for (const scenario of plan.comparisonScenarios) {
    const c = rows.find(
      (row) => row.scenario === scenario && row.adapter === 'composite'
    );
    const r = rows.find(
      (row) => row.scenario === scenario && row.adapter === 'reactive'
    );
    const pair = (key, divisor = 1) =>
      `${format(c?.metrics[key]?.mean, divisor)} / ${format(r?.metrics[key]?.mean, divisor)}`;
    main.push([
      scenario,
      `${c?.validRuns || 0} / ${r?.validRuns || 0}`,
      pair('update_convergence_ms.p95'),
      pair('cpu_ms_per_operation'),
      pair('app_rss_bytes', 1048576),
      pair('completed_operations_per_second'),
    ]);
    resources.push([
      scenario,
      pair('app_heap_used_bytes', 1048576),
      pair('gc_ms_per_operation'),
      pair('event_loop_p95_ms'),
      pair('mongo_cpu_ms_per_operation'),
      pair('bytes_per_operation', 1024),
    ]);
  }
  for (const entry of summary.comparisons)
    for (const comparison of entry.comparisons) {
      if (comparison.status !== 'compared') {
        evidence.push([entry.scenario, 'blocked', '', comparison.reason || '']);
        continue;
      }
      for (const detail of comparison.report.details)
        if (
          [
            'update_convergence_ms.p95',
            'cpu_ms_per_operation',
            'app_rss_bytes',
            'completed_operations_per_second',
            'event_loop_p99_ms',
          ].includes(detail.metric)
        )
          evidence.push([
            entry.scenario,
            detail.metric,
            detail.effect || detail.status,
            detail.reason || '',
          ]);
    }
  const features = plan.reactiveSpecificScenarios.map((scenario) => {
    const run = summary.reactiveSpecific.find(
      (run) => run.scenario === scenario
    );
    const m = run?.status === 'valid' ? run.metrics : {};
    return [
      scenario,
      run?.status || 'not-run',
      format(get(m, 'update_convergence_ms.p95')),
      format(m.cpu_ms_per_operation),
      format(m.app_rss_bytes, 1048576),
      format(m.completed_operations_per_second),
    ];
  });
  const backend = summary.reactiveSpecific.find(
    (run) => run.scenario === 'backend'
  );
  const primitives =
    backend?.status === 'valid'
      ? Object.entries(backend.metrics.backend || {}).map(([name, m]) => [
          name,
          m.count,
          format(m.mean),
          format(m.p95),
        ])
      : [];
  return [
    [
      'Execution',
      ['Job', 'Status', 'Error'],
      summary.execution.jobs.map((job) => [
        job.id,
        job.status,
        job.error || '',
      ]),
    ],
    [
      'Shared cases',
      [
        'Scenario',
        'Valid C / R',
        'Update p95 ms C / R',
        'CPU ms/op C / R',
        'Peak RSS MiB C / R',
        'Completed ops/s C / R',
      ],
      main,
    ],
    [
      'Additional resource costs',
      [
        'Scenario',
        'Peak heap MiB C / R',
        'GC ms/op C / R',
        'Event-loop p95 ms C / R',
        'Mongo CPU ms/op C / R',
        'DDP KiB/op C / R',
      ],
      resources,
    ],
    [
      'Paired evidence (reactive relative to composite)',
      ['Scenario', 'Metric', 'Effect', 'Note'],
      evidence,
    ],
    [
      'Reactive-only features (one descriptive run each)',
      [
        'Scenario',
        'Status',
        'Update p95 ms',
        'CPU ms/op',
        'Peak RSS MiB',
        'Completed ops/s',
      ],
      features,
    ],
    [
      'Backend primitives (one descriptive run)',
      ['Primitive', 'Iterations', 'Mean ms', 'p95 ms'],
      primitives,
    ],
    [
      'Failed or interrupted runs',
      ['Scenario', 'Adapter', 'Errors'],
      summary.errors.map((error) => [
        error.scenario,
        error.adapter,
        error.errors.join('; '),
      ]),
    ],
  ];
}

export async function writeExperimentReport(directory) {
  const summary = await collectExperiment(directory);
  const { plan, execution, coordinates } = summary;
  const title = `Meteor ${plan.meteor} benchmark experiments`;
  const notes = [
    `Batch status: ${execution.status}; ${execution.completedJobs}/${execution.plannedJobs} jobs complete. ${execution.reason || ''}`,
    `${summary.validRuns}/${summary.totalRuns} recorded runs valid. C = publish-composite ${plan.composite}; R = local reactive-publish.`,
    `Recorded runtimes: Meteor ${coordinates.meteor.join(', ') || 'not measured'}; application Node ${coordinates.node.join(', ') || 'not measured'}; MongoDB ${coordinates.mongo.join(', ') || 'not measured'}.`,
    `Shared cases request ${plan.pairs} independent alternating pairs, ${plan.warmup} warmup and ${plan.operations} measured operations, ${plan.clients} clients, ${plan.parents} parents, ${plan.children} children per parent; seed ${plan.seed}. Fresh applications and databases per run.`,
    'Values are means of per-run summaries, including mean per-run percentiles and mean sampled peak memory; not pooled percentiles. All requested valid repetitions are required for comparison. Consult per-case reports for confidence intervals and sample sufficiency. No universal library score is assigned.',
    'These completion-paced experiments include correctness checks and fixed no-output observation waits in throughput. They do not measure saturation capacity. Reactive-only and backend runs have one repetition and are descriptive. Backend timings exclude DDP roundtrips and include first iterations. No forced-GC retention, query profiling or offered-load sweep.',
    'Inspect host observations before drawing conclusions: CPU, memory and I/O contention can distort measurements. Sampling does not establish that the host was idle. A stopped batch is incomplete; raw timeout errors remain recorded without assuming their cause.',
    `Reactive package source hash: ${plan.identities.source.hash}. Harness: ${plan.identities.harness}.`,
  ];
  if (execution.hostSamplingError)
    notes.push(`Host sampling error: ${execution.hostSamplingError}`);
  const sections = reportSections(summary);
  const links = [
    ['Experiment plan', 'plan.json'],
    ['Execution log', 'execution.json'],
    ['Summary JSON', 'summary.json'],
    ['Summary CSV', 'summary.csv'],
    ...summary.comparisons.map((entry) => [
      `${entry.scenario} interactive comparison`,
      entry.report,
    ]),
    ...summary.reactiveSpecific.map((entry) => [
      `${entry.scenario} raw result`,
      entry.path,
    ]),
  ];
  if (
    await fs
      .stat(path.join(directory, 'host-observations.jsonl'))
      .catch(() => null)
  )
    links.push(['Host observations', 'host-observations.jsonl']);
  if (
    await fs
      .stat(path.join(directory, 'runtime-verification.json'))
      .catch(() => null)
  )
    links.push(['Runtime/package verification', 'runtime-verification.json']);
  const md = [
    `# ${title}`,
    '',
    ...notes.flatMap((note) => [escapeMarkdown(note), '']),
  ];
  for (const [heading, headers, rows] of sections) {
    md.push(
      `## ${heading}`,
      '',
      rows.length
        ? [headers, headers.map(() => '---'), ...rows]
            .map((row) => `| ${row.map(escapeMarkdown).join(' | ')} |`)
            .join('\n')
        : 'No recorded results.',
      ''
    );
  }
  md.push(
    '## Artifacts and reproduction',
    '',
    ...links.map(([label, link]) => `- [${label}](${link})`),
    '',
    'From the repository root, run a fresh batch with `npm run bench:experiments -- --meteor <release> --output <new-directory>` (or `--meteor-cli /path/to/meteor/meteor`). Reports are generated automatically. Re-read existing results with `npm run bench:experiments -- report --output <directory>`.',
    ''
  );
  const html = [
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:1300px;margin:40px auto;padding:0 24px;color:#182334}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid #dce3eb;text-align:left;padding:10px}th{background:#f2f5f9}a{color:#165bb6}.scroll{overflow:auto}p{line-height:1.6}</style><h1>${escapeHtml(title)}</h1>`,
    ...notes.map((note) => `<p>${escapeHtml(note)}</p>`),
    ...sections.map(
      ([heading, headers, rows]) =>
        `<h2>${escapeHtml(heading)}</h2><div class="scroll"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>${rows.length ? '' : '<p>No recorded results.</p>'}</div>`
    ),
    `<h2>Artifacts</h2><ul>${links.map(([label, link]) => `<li><a href="${escapeHtml(link)}">${escapeHtml(label)}</a></li>`).join('')}<li><a href="summary.md">Full written report and reproduction</a></li></ul></html>`,
  ];
  const csv = [
    [
      'scenario',
      'adapter',
      'valid_runs',
      'metric',
      'mean',
      'min',
      'max',
      'sample_standard_deviation',
    ],
  ];
  for (const row of summary.comparisonRows)
    for (const [metric, values] of Object.entries(row.metrics))
      csv.push([
        row.scenario,
        row.adapter,
        row.validRuns,
        metric,
        values.mean,
        values.min,
        values.max,
        values.sd,
      ]);
  const outputs = {
    'summary.json': JSON.stringify(summary, null, 2) + '\n',
    'summary.md': md.join('\n'),
    'index.html': html.join('\n'),
    'summary.csv':
      csv
        .map((row) =>
          row
            .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
            .join(',')
        )
        .join('\n') + '\n',
  };
  for (const [name, content] of Object.entries(outputs)) {
    await fs.writeFile(path.join(directory, `${name}.tmp`), content);
    await fs.rename(
      path.join(directory, `${name}.tmp`),
      path.join(directory, name)
    );
  }
  return summary;
}
