import { executeInTab, isSafari, reloadTab, removeSiteData } from './browser-api.js';
import { resetSafariSite } from './safari.js';

export async function resetSite(tabId: number, url: URL): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.origin === 'null') {
    throw new Error('Open an HTTP or HTTPS page first.');
  }
  if (isSafari) {
    await resetSafariSite(tabId, url);
    return;
  }
  await executeInTab(tabId, url.origin);
  await removeSiteData(url);
  await reloadTab(tabId);
}
