import puppeteer from 'puppeteer-core';

export async function browserCheck({ url, token, profile, executable }) {
  const browser = await puppeteer.launch({
    executablePath:
      executable || process.env.CHROME_BIN || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: profile.timeout,
    });
    await page.waitForFunction(() => window.bench?.Meteor.status().connected, {
      timeout: profile.timeout,
    });
    let deadline;
    const results = await Promise.race([
      page.evaluate(
        async ({ token, operations, timeout }) => {
          const { Meteor } = window.bench;
          const samples = [];
          let sub;
          const ready = new Promise((resolve, reject) => {
            sub = Meteor.subscribe('bench', token, {
              onReady: resolve,
              onError: reject,
            });
          });
          let timer;
          try {
            await Promise.race([
              ready,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Browser subscription timeout')),
                  timeout
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          if ((await sub.data('value')).count !== 0)
            throw new Error('Initial browser data missing');
          for (let i = 0; i < operations; i++) {
            const start = performance.now();
            await sub.setData('value', { count: i + 1, label: 'temporary' });
            await sub.setData('value.label', undefined);
            const actual = await sub.data('value');
            if (actual.count !== i + 1 || 'label' in actual)
              throw new Error('Browser subscription data did not converge');
            samples.push(performance.now() - start);
          }
          sub.stop();
          return { samples_ms: samples, client: navigator.userAgent };
        },
        { token, operations: profile.operations, timeout: profile.timeout }
      ),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Browser workload timed out')),
          profile.timeout
        );
      }),
    ]).finally(() => clearTimeout(deadline));
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    return results;
  } finally {
    await browser.close();
  }
}
