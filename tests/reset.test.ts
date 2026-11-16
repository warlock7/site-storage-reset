import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import firefox from 'selenium-webdriver/firefox.js';
import type { Driver } from 'selenium-webdriver/firefox.js';
import { prepareFixture } from './fixture.ts';

interface Site {
  url: string;
  tabId: number;
  handle: string;
}

interface SiteState {
  local: string | null;
  session: string | null;
  cache: boolean;
  database: boolean;
  documentRetained: boolean;
  cookie: boolean;
}

interface ResetResult {
  ok: boolean;
  message?: string;
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
    browser.tabs.create({url, active: false}).then(tab => done(tab.id));
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

async function seedSite(driver: Driver, site: Site): Promise<void> {
  await driver.switchTo().window(site.handle);
  await driver.manage().addCookie({ name: 'sentinel', value: 'cookie', httpOnly: true, path: '/' });
  const result = await driver.executeAsyncScript<string>(`
    const done = arguments[0];
    (async () => {
      window.resetTestMarker = true;
      localStorage.setItem('sentinel', 'local');
      sessionStorage.setItem('sentinel', 'session');
      const cache = await caches.open('sentinel-cache');
      await cache.put('/cached', new Response('cached'));
      const {promise, resolve, reject} = Promise.withResolvers();
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

async function siteState(driver: Driver, site: Site): Promise<SiteState> {
  await driver.switchTo().window(site.handle);
  const state = await driver.executeAsyncScript<Omit<SiteState, 'cookie'>>(`
    const done = arguments[0];
    Promise.all([caches.keys(), indexedDB.databases()]).then(([cacheNames, databases]) => done({
      local: localStorage.getItem('sentinel'),
      session: sessionStorage.getItem('sentinel'),
      cache: cacheNames.includes('sentinel-cache'),
      database: databases.some(database => database.name === 'sentinel-db'),
      documentRetained: window.resetTestMarker === true,
    }));
  `);
  return {
    ...state,
    cookie: (await driver.manage().getCookies()).some((cookie) => cookie.name === 'sentinel'),
  };
}

async function reset(
  driver: Driver,
  extension: string,
  site: Site,
  expectedUrl = site.url,
): Promise<ResetResult> {
  await driver.switchTo().window(extension);
  return driver.executeAsyncScript<ResetResult>(
    `
    const [tabId, url, done] = arguments;
    import(browser.runtime.getURL('fixture.js'))
      .then(({resetSite}) => resetSite(tabId, new URL(url)))
      .then(() => done({ok: true}), error => done({ok: false, message: String(error)}));
  `,
    site.tabId,
    expectedUrl,
  );
}

async function runWithExtension(
  run: (driver: Driver, extension: string) => Promise<void>,
): Promise<void> {
  const extensionPath = await mkdtemp(join(tmpdir(), 'site-reset-test-'));
  let driver: Driver | undefined;
  try {
    // Tests use a temporary extension tab, not the toolbar popup. Permissions are
    // restricted to fixture hosts and do not change the installed extension.
    await prepareFixture(extensionPath, 'firefox');
    const manifestPath = join(extensionPath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.host_permissions = ['http://localhost/*', 'http://127.0.0.1/*'];
    await writeFile(manifestPath, JSON.stringify(manifest));

    const options = new firefox.Options().addArguments('-headless');
    if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
    const service = new firefox.ServiceBuilder(process.env.GECKODRIVER).addArguments(
      '--allow-system-access',
    );
    driver = firefox.Driver.createSession(options, service.build());
    const addonId = await driver.installAddon(extensionPath, true);
    await driver.setContext(firefox.Context.CHROME);
    const extensionUrl = await driver.executeScript<string>(
      'return WebExtensionPolicy.getByID(arguments[0]).getURL("fixture.html")',
      addonId,
    );
    await driver.setContext(firefox.Context.CONTENT);
    await driver.get(extensionUrl);
    await run(driver, await driver.getWindowHandle());
  } finally {
    try {
      if (driver) await driver.quit();
    } finally {
      await rm(extensionPath, { recursive: true, force: true });
    }
  }
}

describe('site storage reset', () => {
  let servers: Server[];
  before(async () => {
    servers = [await startServer(), await startServer()];
  });
  after(async () => {
    await Promise.all(servers.map((server) => promisify(server.close.bind(server))()));
  });

  it('clears a non-default port while preserving unrelated sites', async () => {
    await runWithExtension(async (driver, extension) => {
      const target = await createSite(driver, extension, 'localhost', servers[0]);
      const otherPort = await createSite(driver, extension, 'localhost', servers[1]);
      const otherHost = await createSite(driver, extension, '127.0.0.1', servers[0]);
      for (const site of [target, otherPort, otherHost]) await seedSite(driver, site);

      assert.deepEqual(await reset(driver, extension, target), { ok: true });
      assert.deepEqual(await siteState(driver, target), {
        local: null,
        session: null,
        cache: false,
        database: false,
        cookie: false,
        documentRetained: false,
      });
      const otherPortState = await siteState(driver, otherPort);
      assert.equal(otherPortState.local, 'local');
      assert.equal(otherPortState.database, true);
      assert.deepEqual(await siteState(driver, otherHost), {
        local: 'local',
        session: 'session',
        cache: true,
        database: true,
        cookie: true,
        documentRetained: true,
      });
    });
  });

  it('does not clear or reload when the tab changed origin', async () => {
    await runWithExtension(async (driver, extension) => {
      const target = await createSite(driver, extension, '127.0.0.1', servers[0]);
      await seedSite(driver, target);
      const result = await reset(
        driver,
        extension,
        target,
        `http://localhost:${port(servers[0])}/`,
      );
      assert.equal(result.ok, false);
      assert.deepEqual(await siteState(driver, target), {
        local: 'local',
        session: 'session',
        cache: true,
        database: true,
        cookie: true,
        documentRetained: true,
      });
    });
  });
});
