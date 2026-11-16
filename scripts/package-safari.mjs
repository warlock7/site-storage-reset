import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('Safari packaging requires macOS and Xcode; it is not available on this platform.');
  process.exit(1);
}

const converter = spawnSync('xcrun', ['--find', 'safari-web-extension-converter'], {
  encoding: 'utf8',
});
if (converter.error || converter.status !== 0) {
  console.error(
    'Safari packaging requires Xcode with safari-web-extension-converter. Install Xcode, open it to complete setup, and select it with sudo xcode-select -s /Applications/Xcode.app/Contents/Developer.',
  );
  process.exit(1);
}

const source = fileURLToPath(new URL('../.output/safari-mv3/', import.meta.url));
const projectLocation = fileURLToPath(new URL('../safari-build/', import.meta.url));
try {
  await mkdir(projectLocation);
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error(
      `Refusing to overwrite ${projectLocation}. Move or remove it before packaging again.`,
    );
    process.exit(1);
  }
  throw error;
}

const result = spawnSync(
  'xcrun',
  [
    'safari-web-extension-converter',
    source,
    '--project-location',
    projectLocation,
    '--bundle-identifier',
    'com.kittl.sitestoragereset',
    '--macos-only',
    '--swift',
    '--no-prompt',
    '--no-open',
  ],
  { stdio: 'inherit' },
);
if (result.error) {
  console.error(`Could not run Safari extension converter: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(
    `Safari extension conversion failed. Inspect ${projectLocation} before trying again.`,
  );
  process.exit(result.status ?? 1);
}
