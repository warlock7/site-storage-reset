import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { WebDriver } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { prepareFixture } from './fixture.ts';

interface Site {
  url: string;
  tabId: number;
  handle: string;
}

async function startServer(): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Safari storage API fixture</title>');
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
  await promise;
  return server;
}

async function createSite(driver: WebDriver, extension: string, url: string): Promise<Site> {
  await driver.switchTo().window(extension);
  const previous = new Set(await driver.getAllWindowHandles());
  const tabId = await driver.executeAsyncScript<number>(
    `
    const [url, done] = arguments;
    chrome.tabs.create({url, active: false}).then(tab => done(tab.id));
  `,
    url,
  );
  const handle = await driver.wait(async () => {
    const added = (await driver.getAllWindowHandles()).filter((item) => !previous.has(item));
    return added.length === 1 ? added[0] : false;
  }, 10_000);
  if (!handle) throw new Error('Fixture tab was not created');
  await driver.switchTo().window(handle);
  await driver.wait(async () => (await driver.getCurrentUrl()) === url, 10_000);
  return { url, tabId, handle };
}

async function seedStorage(driver: WebDriver, site: Site): Promise<void> {
  await driver.switchTo().window(site.handle);
  const result = await driver.executeAsyncScript<string>(`
    const done = arguments[0];
    (async () => {
      window.resetTestMarker = true;
      localStorage.setItem('sentinel', 'local');
      sessionStorage.setItem('sentinel', 'session');
      await (await caches.open('sentinel-cache')).put('/cached', new Response('cached'));
      for (const name of ['sentinel-db', 'second-db']) {
        const {promise, resolve, reject} = Promise.withResolvers();
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('items');
        request.onsuccess = () => { request.result.close(); resolve(); };
        request.onerror = () => reject(request.error);
        await promise;
      }
      return 'ok';
    })().then(done, error => done(String(error)));
  `);
  assert.equal(result, 'ok');
}

async function storageState(driver: WebDriver, site: Site) {
  await driver.switchTo().window(site.handle);
  return driver.executeAsyncScript<{
    local: string | null;
    session: string | null;
    caches: string[];
    databases: string[];
    documentRetained: boolean;
  }>(`
    const done = arguments[0];
    Promise.all([caches.keys(), indexedDB.databases()]).then(([names, databases]) => done({
      local: localStorage.getItem('sentinel'),
      session: sessionStorage.getItem('sentinel'),
      caches: names.sort(),
      databases: databases.map(database => database.name).sort(),
      documentRetained: window.resetTestMarker === true,
    }));
  `);
}

async function setCookie(driver: WebDriver, extension: string, details: object): Promise<void> {
  await driver.switchTo().window(extension);
  const result = await driver.executeAsyncScript<{ ok: boolean; error?: string }>(
    `
    const [details, done] = arguments;
    chrome.cookies.set(details).then(cookie => done({ok: !!cookie}), error => done({ok: false, error: String(error)}));
  `,
    details,
  );
  assert.deepEqual(result, { ok: true });
}

async function cookies(driver: WebDriver, extension: string) {
  await driver.switchTo().window(extension);
  return driver.executeAsyncScript<
    Array<{
      name: string;
      domain: string;
      path: string;
      value: string;
      hostOnly: boolean;
      httpOnly: boolean;
    }>
  >(`
    const done = arguments[0];
    chrome.cookies.getAll({}).then(done);
  `);
}

async function reset(driver: WebDriver, extension: string, site: Site, url = site.url) {
  await driver.switchTo().window(extension);
  return driver.executeAsyncScript<{ ok: boolean; message?: string }>(
    `
    const [tabId, url, done] = arguments;
    // Chromium's Promise-based APIs exercise the real module, not a mocked browser API.
    globalThis.browser = chrome;
    import(chrome.runtime.getURL('fixture.js'))
      .then(({resetSafariSite}) => resetSafariSite(tabId, new URL(url)))
      .then(() => done({ok: true}), error => done({ok: false, message: String(error)}));
  `,
    site.tabId,
    url,
  );
}

async function withExtension(
  run: (driver: WebDriver, extension: string) => Promise<void>,
  httpsPermission = true,
): Promise<void> {
  const extensionPath = await mkdtemp(join(tmpdir(), 'site-reset-safari-api-'));
  let driver: WebDriver | undefined;
  try {
    await prepareFixture(extensionPath, 'safari');
    const manifestPath = join(extensionPath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = publicKey.export({ type: 'spki', format: 'der' });
    manifest.key = key.toString('base64');
    manifest.permissions = ['activeTab', 'scripting', 'cookies'];
    // These wider grants are fixture-only, needed to observe parent and unrelated cookies.
    manifest.host_permissions = [
      'http://*.localhost/*',
      'https://*.localhost/*',
      'http://127.0.0.1/*',
      'https://127.0.0.1/*',
      'http://fixture.test/*',
      'https://fixture.test/*',
    ];
    if (!httpsPermission) {
      manifest.host_permissions = manifest.host_permissions.filter((pattern: string) =>
        pattern.startsWith('http:'),
      );
    }
    delete manifest.optional_host_permissions;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const extensionId = [...createHash('sha256').update(key).digest().subarray(0, 16)]
      .flatMap((byte) => [byte >> 4, byte & 15])
      .map((nibble) => String.fromCharCode(97 + nibble))
      .join('');
    const options = new chrome.Options();
    options.addArguments(
      '--headless=new',
      '--no-proxy-server',
      '--host-resolver-rules=MAP fixture.test 127.0.0.1',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    );
    if (process.env.CHROME_BINARY) options.setBinaryPath(process.env.CHROME_BINARY);
    const service = new chrome.ServiceBuilder(process.env.CHROMEDRIVER);
    driver = chrome.Driver.createSession(options, service.build());
    await driver.get(`chrome-extension://${extensionId}/fixture.html`);
    await run(driver, await driver.getWindowHandle());
  } finally {
    try {
      if (driver) await driver.quit();
    } finally {
      await rm(extensionPath, { recursive: true, force: true });
    }
  }
}

describe('Safari-compatible storage APIs in Chromium (not a Safari test)', () => {
  let server: Server;
  let base: string;
  before(async () => {
    server = await startServer();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server is not listening');
    base = `:${address.port}`;
  });
  after(async () => {
    if (server) await promisify(server.close.bind(server))();
  });

  it('clears an insecure HTTP origin where Cache Storage is unavailable', async () => {
    await withExtension(async (driver, extension) => {
      const target = await createSite(driver, extension, `http://fixture.test${base}/`);
      await driver.switchTo().window(target.handle);
      const seeded = await driver.executeAsyncScript<boolean>(`
        const done = arguments[0];
        localStorage.setItem('sentinel', 'local');
        sessionStorage.setItem('sentinel', 'session');
        const request = indexedDB.open('insecure-db', 1);
        request.onsuccess = () => {
          request.result.close();
          done(!isSecureContext && !('caches' in globalThis));
        };
        request.onerror = () => done(false);
      `);
      assert.equal(seeded, true);
      await setCookie(driver, extension, {
        url: target.url,
        name: 'sentinel',
        value: 'cookie',
        httpOnly: true,
      });
      assert.deepEqual(await reset(driver, extension, target), { ok: true });
      await driver.switchTo().window(target.handle);
      const state = await driver.executeAsyncScript<{
        local: string | null;
        session: string | null;
        databases: string[];
      }>(`
        const done = arguments[0];
        indexedDB.databases().then(databases => done({
          local: localStorage.getItem('sentinel'),
          session: sessionStorage.getItem('sentinel'),
          databases: databases.map(database => database.name),
        }));
      `);
      assert.deepEqual(state, { local: null, session: null, databases: [] });
      assert.equal(
        (await cookies(driver, extension)).some((cookie) => cookie.name === 'sentinel'),
        false,
      );
    });
  });

  it('clears target storage and applicable cookies while preserving unrelated hosts', async () => {
    await withExtension(async (driver, extension) => {
      const target = await createSite(driver, extension, `http://target.test.localhost${base}/`);
      const other = await createSite(driver, extension, `http://127.0.0.1${base}/`);
      await seedStorage(driver, target);
      await seedStorage(driver, other);
      await setCookie(driver, extension, {
        url: target.url,
        name: 'duplicate',
        value: 'root',
        path: '/',
        httpOnly: true,
      });
      await setCookie(driver, extension, {
        url: new URL('/deep', target.url).href,
        name: 'duplicate',
        value: 'deep',
        path: '/deep',
        httpOnly: true,
      });
      await setCookie(driver, extension, {
        url: target.url,
        name: 'duplicate',
        value: 'parent',
        domain: 'test.localhost',
        path: '/',
      });
      await setCookie(driver, extension, {
        url: `http://child.target.test.localhost${base}/`,
        name: 'child-only',
        value: 'keep',
        path: '/',
      });
      await setCookie(driver, extension, {
        url: new URL('/deep', target.url).href,
        name: 'parent',
        value: 'domain',
        domain: 'test.localhost',
        path: '/deep',
      });
      await setCookie(driver, extension, {
        url: `http://test.localhost${base}/`,
        name: 'parent-host-only',
        value: 'keep',
        path: '/',
      });
      await setCookie(driver, extension, {
        url: other.url,
        name: 'other',
        value: 'keep',
        httpOnly: true,
        path: '/',
      });
      const before = await cookies(driver, extension);
      assert.equal(before.filter((cookie) => cookie.name === 'duplicate').length, 3);
      assert.ok(before.some((cookie) => cookie.name === 'parent' && !cookie.hostOnly));
      await setCookie(driver, extension, {
        url: 'https://target.test.localhost/secure',
        name: 'secure',
        value: 'secure',
        secure: true,
        httpOnly: true,
        path: '/secure',
      });
      assert.deepEqual(await reset(driver, extension, target), { ok: true });
      await driver.switchTo().window(target.handle);
      await driver.wait(
        async () =>
          driver.executeScript<boolean>(`
        return document.readyState === 'complete' &&
          performance.getEntriesByType('navigation')[0]?.type === 'reload';
      `),
        10_000,
      );
      assert.deepEqual(await storageState(driver, target), {
        local: null,
        session: null,
        caches: [],
        databases: [],
        documentRetained: false,
      });
      assert.deepEqual(await storageState(driver, other), {
        local: 'local',
        session: 'session',
        caches: ['sentinel-cache'],
        databases: ['second-db', 'sentinel-db'],
        documentRetained: true,
      });
      const remaining = await cookies(driver, extension);
      assert.equal(
        remaining.some((cookie) => ['duplicate', 'parent', 'secure'].includes(cookie.name)),
        false,
      );
      assert.ok(
        remaining.some((cookie) => cookie.name === 'parent-host-only' && cookie.value === 'keep'),
      );
      assert.ok(
        remaining.some((cookie) => cookie.name === 'child-only' && cookie.value === 'keep'),
      );
      assert.ok(remaining.some((cookie) => cookie.name === 'other' && cookie.httpOnly));
    });
  });

  it('rejects an origin mismatch and unsupported URL without changing storage or cookies', async () => {
    await withExtension(async (driver, extension) => {
      const target = await createSite(driver, extension, `http://target.test.localhost${base}/`);
      await seedStorage(driver, target);
      await setCookie(driver, extension, {
        url: target.url,
        name: 'sentinel',
        value: 'keep',
        httpOnly: true,
      });
      assert.equal(
        (await reset(driver, extension, target, `http://test.localhost${base}/`)).ok,
        false,
      );
      assert.equal((await reset(driver, extension, target, 'file:///tmp/unsupported')).ok, false);
      assert.deepEqual(await storageState(driver, target), {
        local: 'local',
        session: 'session',
        caches: ['sentinel-cache'],
        databases: ['second-db', 'sentinel-db'],
        documentRetained: true,
      });
      assert.ok((await cookies(driver, extension)).some((cookie) => cookie.name === 'sentinel'));
    });
  });

  it('rejects missing HTTPS host permission before changing the site', async () => {
    await withExtension(async (driver, extension) => {
      const target = await createSite(driver, extension, `http://target.test.localhost${base}/`);
      await seedStorage(driver, target);
      await setCookie(driver, extension, {
        url: target.url,
        name: 'sentinel',
        value: 'keep',
        httpOnly: true,
      });
      const result = await reset(driver, extension, target);
      assert.equal(result.ok, false);
      assert.match(result.message ?? '', /permissions/i);
      assert.deepEqual(await storageState(driver, target), {
        local: 'local',
        session: 'session',
        caches: ['sentinel-cache'],
        databases: ['second-db', 'sentinel-db'],
        documentRetained: true,
      });
      assert.ok((await cookies(driver, extension)).some((cookie) => cookie.name === 'sentinel'));
    }, false);
  });

  it('reports a blocked IndexedDB deletion without removing cookies or reloading', async () => {
    await withExtension(async (driver, extension) => {
      const target = await createSite(driver, extension, `http://target.test.localhost${base}/`);
      await seedStorage(driver, target);
      await setCookie(driver, extension, {
        url: target.url,
        name: 'sentinel',
        value: 'keep',
        httpOnly: true,
      });
      const blocker = await createSite(driver, extension, target.url);
      await driver.switchTo().window(blocker.handle);
      const opened = await driver.executeAsyncScript<string>(`
        const done = arguments[0];
        const request = indexedDB.open('sentinel-db');
        request.onsuccess = () => { window.blockingDatabase = request.result; done('open'); };
        request.onerror = () => done(String(request.error));
      `);
      assert.equal(opened, 'open');
      const result = await reset(driver, extension, target);
      assert.equal(result.ok, false);
      assert.match(result.message ?? '', /IndexedDB deletion blocked/i);
      assert.equal((await storageState(driver, target)).documentRetained, true);
      assert.ok((await cookies(driver, extension)).some((cookie) => cookie.name === 'sentinel'));
      await driver.switchTo().window(blocker.handle);
      await driver.executeScript('window.blockingDatabase.close()');
    });
  });
});
