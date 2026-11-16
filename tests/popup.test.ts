import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { By, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';

// Exercise the actual popup in Chromium while simulating Safari withholding the tab URL.
describe('Safari popup permission fallback (simulated Safari APIs)', () => {
  let server: Server;
  let driver: chrome.Driver;
  let origin: string;

  before(async () => {
    server = createServer(async (request, response) => {
      const root = resolve('.output/safari-mv3');
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const path = resolve(root, `.${pathname}`);
      if (!path.startsWith(root + sep)) {
        response.writeHead(404).end();
        return;
      }
      const contentTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
      };
      try {
        const data = await readFile(path);
        response
          .writeHead(200, {
            'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream',
          })
          .end(data);
      } catch {
        response.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture server was not listening');
    origin = `http://127.0.0.1:${address.port}`;
    const options = new chrome.Options().addArguments('--headless=new', '--no-proxy-server');
    if (process.env.CHROME_BINARY) options.setBinaryPath(process.env.CHROME_BINARY);
    driver = chrome.Driver.createSession(
      options,
      new chrome.ServiceBuilder(process.env.CHROMEDRIVER).build(),
    );
    await driver.sendDevToolsCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        Object.defineProperty(navigator, 'userAgent', {value: 'Mozilla/5.0 Version/27.0 Safari/605.1.15'});
        Object.defineProperty(navigator, 'vendor', {value: 'Apple Computer, Inc.'});
        window.granted = false;
        window.approve = true;
        window.reportedUrl = location.origin + '/page';
        window.browser = {
          runtime: {id: 'site-storage-reset-test'},
          tabs: {
            query: async () => [window.granted ? {id: 1, url: window.reportedUrl} : {id: 1}],
            get: async () => ({id: 1, url: window.reportedUrl}),
            reload: async () => {},
          },
          permissions: {
            request: async () => { window.granted = window.approve; return window.approve; },
            contains: async () => window.granted,
          },
          scripting: {executeScript: async ({func, args}) => [{result: await func(...args)}]},
          cookies: {getAllCookieStores: async () => [{id: '0', tabIds: [1]}], getAll: async () => [], remove: async () => null},
        };
      `,
    });
  });

  after(async () => {
    if (driver) await driver.quit();
    if (server) await promisify(server.close.bind(server))();
  });

  async function openFallback(): Promise<void> {
    await driver.get(`${origin}/popup.html`);
    await driver.wait(until.elementIsVisible(await driver.findElement(By.id('site-url'))), 5000);
    assert.equal(await driver.findElement(By.id('clear')).isEnabled(), false);
    await driver.executeScript("localStorage.setItem('sentinel', 'keep')");
    await driver.findElement(By.id('site-url')).sendKeys(origin);
  }

  it('enables clearing only after site access and origin verification', async () => {
    await openFallback();
    await driver.findElement(By.id('allow-site')).click();
    await driver.wait(until.elementIsEnabled(await driver.findElement(By.id('clear'))), 5000);
    assert.equal(await driver.findElement(By.id('site')).getText(), origin);
    await driver.findElement(By.id('clear')).click();
    await driver.wait(
      until.elementTextContains(await driver.findElement(By.id('status')), 'Reset finished'),
      5000,
    );
    assert.equal(await driver.executeScript("return localStorage.getItem('sentinel')"), null);
  });

  it('keeps data and the clear button disabled when access is denied', async () => {
    await openFallback();
    await driver.executeScript('window.approve = false');
    await driver.findElement(By.id('allow-site')).click();
    await driver.wait(
      until.elementTextContains(await driver.findElement(By.id('status')), 'denied'),
      5000,
    );
    assert.equal(await driver.findElement(By.id('clear')).isEnabled(), false);
    assert.equal(await driver.executeScript("return localStorage.getItem('sentinel')"), 'keep');
  });

  it('does not clear a different active origin after permission is granted', async () => {
    await openFallback();
    await driver.executeScript("window.reportedUrl = 'http://other.example/'");
    await driver.findElement(By.id('allow-site')).click();
    await driver.wait(
      until.elementTextContains(await driver.findElement(By.id('status')), 'cannot verify'),
      5000,
    );
    assert.equal(await driver.findElement(By.id('clear')).isEnabled(), false);
    assert.equal(await driver.executeScript("return localStorage.getItem('sentinel')"), 'keep');
  });
});
