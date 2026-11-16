import { cp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';

/** Copy the production extension and bundle its real reset modules into a test-only page. */
export async function prepareFixture(
  extensionPath: string,
  browser: 'chrome' | 'firefox' | 'safari',
) {
  await cp(`.output/${browser}-mv3`, extensionPath, { recursive: true });
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      outDir: extensionPath,
      emptyOutDir: false,
      target: 'esnext',
      lib: {
        entry: resolve('tests/fixture-entry.ts'),
        formats: ['es'],
        fileName: () => 'fixture.js',
      },
    },
  });
  await writeFile(
    resolve(extensionPath, 'fixture.html'),
    '<!doctype html><title>Storage test</title>',
  );
}
