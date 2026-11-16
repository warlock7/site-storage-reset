import { spawnSync } from 'node:child_process';

const browser = process.argv[2];
if (!['chrome', 'edge', 'brave', 'opera'].includes(browser) || process.argv.length !== 3) {
  console.error('Usage: pnpm test:browser <chrome|edge|brave|opera>');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test', 'tests/chromium.test.ts'], {
    env: { ...process.env, SITE_RESET_BROWSER: browser },
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
}
