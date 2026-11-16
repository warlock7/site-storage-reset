import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { WebDriver as Driver } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import edge from 'selenium-webdriver/edge.js';
import { prepareFixture } from './fixture.ts';

const targetBrowser = process.env.SITE_RESET_BROWSER ?? 'chrome';
if (!['chrome', 'edge', 'brave', 'opera'].includes(targetBrowser)) {
  throw new Error(`Unsupported SITE_RESET_BROWSER: ${targetBrowser}`);
}

interface Site {
  url: string;
  tabId: number;
  handle: string;
}

async function startServer(): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Storage test</title>');
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
  await promise;
  return server;
}

function port(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server is not listening');
  return address.port;
}

async function createSite(
  driver: Driver,
  extension: string,
  hostname: string,
  server: Server,
): Promise<Site> {
  const url = `http://${hostname}:${port(server)}/`;
  await driver.switchTo().window(extension);
  const beforeHandles = new Set(await driver.getAllWindowHandles());
  const tabId = await driver.executeAsyncScript<number>(
    `
    const [url, done] = arguments;
    chrome.tabs.create({url, active: false}, tab => done(tab.id));
  `,
    url,
  );
  const handle = await driver.wait(async () => {
    const handles = (await driver.getAllWindowHandles()).filter((item) => !beforeHandles.has(item));
    return handles.length === 1 ? handles[0] : false;
  }, 10_000);
  if (!handle) throw new Error('Fixture tab was not created');
  await driver.switchTo().window(handle);
  await driver.wait(async () => (await driver.getCurrentUrl()) === url, 10_000);
  return { url, tabId, handle };
}

async function seed(driver: Driver, site: Site): Promise<void> {
  await driver.switchTo().window(site.handle);
  await driver.manage().addCookie({ name: 'sentinel', value: 'cookie', httpOnly: true, path: '/' });
  const result = await driver.executeAsyncScript<string>(`
    const done = arguments[0];
    (async () => {
      window.resetTestMarker = true;
      localStorage.setItem('sentinel', 'local');
      sessionStorage.setItem('sentinel', 'session');
      await (await caches.open('sentinel-cache')).put('/cached', new Response('cached'));
      const { promise, resolve, reject } = Promise.withResolvers();
      const request = indexedDB.open('sentinel-db', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('items');
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
      await promise;
      return 'ok';
    })().then(done, error => done(String(error)));
  `);
  assert.equal(result, 'ok');
}

async function state(driver: Driver, site: Site) {
  await driver.switchTo().window(site.handle);
  const storage = await driver.executeAsyncScript<{
    local: string | null;
    session: string | null;
    cache: boolean;
    database: boolean;
    documentRetained: boolean;
  }>(`
    const done = arguments[0];
    Promise.all([caches.keys(), indexedDB.databases()]).then(([names, databases]) => done({
      local: localStorage.getItem('sentinel'),
      session: sessionStorage.getItem('sentinel'),
      cache: names.includes('sentinel-cache'),
      database: databases.some(database => database.name === 'sentinel-db'),
      documentRetained: window.resetTestMarker === true,
    }));
  `);
  return {
    ...storage,
    cookie: (await driver.manage().getCookies()).some((cookie) => cookie.name === 'sentinel'),
  };
}

async function reset(driver: Driver, extension: string, site: Site, url = site.url) {
  await driver.switchTo().window(extension);
  return driver.executeAsyncScript<{ ok: boolean; message?: string }>(
    `
    const [tabId, url, done] = arguments;
    import(chrome.runtime.getURL('fixture.js'))
      .then(({resetSite}) => resetSite(tabId, new URL(url)))
      .then(() => done({ok: true}), error => done({ok: false, message: String(error)}));
  `,
    site.tabId,
    url,
  );
}

async function verifyBrowser(driver: Driver): Promise<void> {
  if (targetBrowser === 'chrome') return;
  await driver.get('data:text/html,browser-identity');
  const identity = await driver.executeAsyncScript<{ userAgent: string; brave: boolean }>(`
    const done = arguments[0];
    Promise.resolve(navigator.brave?.isBrave()).then(brave => done({
      userAgent: navigator.userAgent,
      brave: brave === true,
    }));
  `);
  if (targetBrowser === 'brave') {
    assert.equal(identity.brave, true, 'BRAVE_BINARY must point to Brave');
  } else {
    const brand = targetBrowser === 'edge' ? /\bEdg\// : /\bOPR\//;
    assert.match(
      identity.userAgent,
      brand,
      `${targetBrowser.toUpperCase()}_BINARY points to a different browser`,
    );
  }
}

async function runWithExtension(
  run: (driver: Driver, extension: string) => Promise<void>,
  browsingDataPermission = true,
): Promise<void> {
  const extensionPath = await mkdtemp(join(tmpdir(), 'site-reset-chromium-'));
  let driver: Driver | undefined;
  try {
    await prepareFixture(extensionPath, 'chrome');
    const manifestPath = join(extensionPath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = publicKey.export({ type: 'spki', format: 'der' });
    manifest.key = key.toString('base64');
    if (!browsingDataPermission) {
      manifest.permissions = manifest.permissions.filter(
        (permission: string) => permission !== 'browsingData',
      );
    }
    manifest.host_permissions = ['http://localhost/*', 'http://127.0.0.1/*'];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const extensionId = [...createHash('sha256').update(key).digest().subarray(0, 16)]
      .flatMap((byte) => [byte >> 4, byte & 15])
      .map((nibble) => String.fromCharCode(97 + nibble))
      .join('');
    const args = [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ];
    if (targetBrowser === 'edge') {
      const binary = process.env.EDGE_BINARY;
      if (!binary) throw new Error('Set EDGE_BINARY to the Edge executable');
      const options = new edge.Options();
      options.addArguments(...args);
      options.setBinaryPath(binary);
      const service = new edge.ServiceBuilder(process.env.EDGEDRIVER);
      driver = edge.Driver.createSession(options, service.build());
    } else {
      const binary = process.env[`${targetBrowser.toUpperCase()}_BINARY`];
      if (targetBrowser !== 'chrome' && !binary) {
        throw new Error(`Set ${targetBrowser.toUpperCase()}_BINARY to the browser executable`);
      }
      const options = new chrome.Options();
      options.addArguments(...args);
      if (binary) options.setBinaryPath(binary);
      const service = new chrome.ServiceBuilder(process.env.CHROMEDRIVER);
      driver = chrome.Driver.createSession(options, service.build());
    }
    await verifyBrowser(driver);
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

describe(`${targetBrowser} site storage reset`, () => {
  let servers: Server[];
  before(async () => {
    servers = [await startServer(), await startServer()];
  });
  after(async () => {
    await Promise.all(servers.map((server) => promisify(server.close.bind(server))()));
  });

  it('clears the target origin and preserves other origins', async () => {
    await runWithExtension(async (driver, extension) => {
      const target = await createSite(driver, extension, 'localhost', servers[0]);
      const otherPort = await createSite(driver, extension, 'localhost', servers[1]);
      const otherHost = await createSite(driver, extension, '127.0.0.1', servers[0]);
      for (const site of [target, otherPort, otherHost]) await seed(driver, site);
      assert.deepEqual(await reset(driver, extension, target), { ok: true });
      assert.deepEqual(await state(driver, target), {
        local: null,
        session: null,
        cache: false,
        database: false,
        documentRetained: false,
        cookie: false,
      });
      const portState = await state(driver, otherPort);
      assert.equal(portState.local, 'local');
      assert.equal(portState.database, true);
      assert.equal(portState.session, 'session');
      assert.equal(portState.cache, true);
      assert.equal(portState.cookie, false);
      assert.deepEqual(await state(driver, otherHost), {
        local: 'local',
        session: 'session',
        cache: true,
        database: true,
        documentRetained: true,
        cookie: true,
      });
    });
  });

  it('leaves data untouched when the tab origin differs or the URL is unsupported', async () => {
    await runWithExtension(async (driver, extension) => {
      const target = await createSite(driver, extension, '127.0.0.1', servers[0]);
      await seed(driver, target);
      const mismatch = await reset(
        driver,
        extension,
        target,
        `http://localhost:${port(servers[0])}/`,
      );
      assert.equal(mismatch.ok, false);
      assert.equal((await reset(driver, extension, target, 'file:///tmp/unsupported')).ok, false);
      assert.deepEqual(await state(driver, target), {
        local: 'local',
        session: 'session',
        cache: true,
        database: true,
        documentRetained: true,
        cookie: true,
      });
    });
  });

  it('reports a closed tab without clearing another site', async () => {
    await runWithExtension(async (driver, extension) => {
      const target = await createSite(driver, extension, 'localhost', servers[0]);
      const other = await createSite(driver, extension, '127.0.0.1', servers[0]);
      await seed(driver, other);
      await driver.switchTo().window(target.handle);
      await driver.close();
      assert.equal((await reset(driver, extension, target)).ok, false);
      assert.deepEqual(await state(driver, other), {
        local: 'local',
        session: 'session',
        cache: true,
        database: true,
        documentRetained: true,
        cookie: true,
      });
    });
  });

  it('reports missing browsingData permission without clearing the tab', async () => {
    await runWithExtension(async (driver, extension) => {
      const target = await createSite(driver, extension, '127.0.0.1', servers[0]);
      await seed(driver, target);
      assert.equal((await reset(driver, extension, target)).ok, false);
      assert.deepEqual(await state(driver, target), {
        local: 'local',
        session: 'session',
        cache: true,
        database: true,
        documentRetained: true,
        cookie: true,
      });
    }, false);
  });
});
