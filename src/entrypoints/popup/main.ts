import { activeTab, isSafari } from '../../browser-api.js';
import { resetSite } from '../../reset.js';
import { requestSafariHostPermissions } from '../../safari.js';

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing popup element: ${selector}`);
  return element;
}

const site = requiredElement<HTMLElement>('#site');
const clear = requiredElement<HTMLButtonElement>('#clear');
const status = requiredElement<HTMLElement>('#status');
const description = requiredElement<HTMLElement>('#description');
const scopeWarning = requiredElement<HTMLElement>('#scope-warning');
const siteAccess = requiredElement<HTMLElement>('#site-access');
const siteUrl = requiredElement<HTMLInputElement>('#site-url');
const allowSite = requiredElement<HTMLButtonElement>('#allow-site');
if (isSafari) {
  description.textContent =
    'Clears accessible unpartitioned cookies and this origin’s local storage, IndexedDB, session storage and Cache Storage, then reloads this tab.';
  scopeWarning.textContent =
    'Safari requires access to this site. Partitioned or inaccessible parent-domain cookies may remain. IndexedDB deletion can be blocked by open connections. HTTP cache is not cleared.';
}
let selectedTabId: number;
let selectedUrl: URL;

function selectTab(tab: browser.tabs.Tab | undefined): void {
  if (tab?.id === undefined || !tab.url) throw new Error('Cannot access the current tab.');
  const url = new URL(tab.url);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Open an HTTP or HTTPS page first.');
  }
  selectedUrl = url;
  selectedTabId = tab.id;
  site.textContent = url.origin;
  siteAccess.hidden = true;
  clear.disabled = false;
  status.textContent = '';
}

async function initialize(): Promise<void> {
  try {
    const tab = await activeTab();
    if (isSafari && (tab?.id === undefined || !tab.url)) {
      site.textContent = 'Safari has not exposed the current page.';
      status.textContent =
        'Enter the page address to request site access, then verify the detected site before clearing.';
      siteAccess.hidden = false;
      return;
    }
    selectTab(tab);
  } catch (error) {
    site.textContent = 'Cannot access this page.';
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

allowSite.addEventListener('click', async () => {
  allowSite.disabled = true;
  try {
    let requestedUrl: URL;
    try {
      requestedUrl = new URL(siteUrl.value);
      if (!['http:', 'https:'].includes(requestedUrl.protocol)) throw new Error();
    } catch {
      throw new Error('Enter an HTTP or HTTPS page address, including http:// or https://.');
    }
    if (!(await requestSafariHostPermissions(requestedUrl))) {
      throw new Error('Site access was denied. No data was cleared.');
    }
    const tab = await activeTab();
    if (!tab?.url || new URL(tab.url).origin !== requestedUrl.origin) {
      throw new Error(
        'Safari still cannot verify the current page. Allow this extension on the site in Safari Settings and reopen it.',
      );
    }
    selectTab(tab);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    allowSite.disabled = false;
  }
});

clear.addEventListener('click', async () => {
  clear.disabled = true;
  status.textContent = 'Clearing…';
  try {
    if (isSafari && !(await requestSafariHostPermissions(selectedUrl))) {
      status.textContent = 'Site access denied. No data was cleared.';
      clear.disabled = false;
      return;
    }
    await resetSite(selectedTabId, selectedUrl);
    status.textContent = isSafari
      ? 'Reset finished. Some cookies may remain.'
      : 'Cleared and reloaded.';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.textContent = `Reset incomplete: ${message}. Some data may already have been cleared.`;
    clear.disabled = false;
  }
});

void initialize();
