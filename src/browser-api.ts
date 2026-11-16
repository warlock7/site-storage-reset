type ChromeApi = {
  runtime: { lastError?: { message?: string } };
  tabs: {
    query: (
      query: { active: boolean; currentWindow: boolean },
      callback: (tabs: browser.tabs.Tab[]) => void,
    ) => void;
    reload: (tabId: number, options: { bypassCache: boolean }, callback: () => void) => void;
  };
  scripting: {
    executeScript: (
      options: object,
      callback: (results: browser.scripting.InjectionResult[]) => void,
    ) => void;
  };
  browsingData: {
    remove: (
      options: { origins: string[] },
      data: { localStorage: boolean; indexedDB: boolean; cookies: boolean },
      callback: () => void,
    ) => void;
  };
};

// Chromium's extension API is not part of the Firefox-only type definitions.
const extensionGlobals = globalThis as unknown as { chrome?: ChromeApi };
const chromeApi = extensionGlobals.chrome;
const isFirefox =
  typeof browser !== 'undefined' && typeof browser.runtime.getBrowserInfo === 'function';
const isChromium = /\b(?:Chrome|Chromium|HeadlessChrome)\//.test(navigator.userAgent);
export const isSafari =
  !isFirefox &&
  !isChromium &&
  typeof browser !== 'undefined' &&
  navigator.vendor === 'Apple Computer, Inc.' &&
  /\bSafari\//.test(navigator.userAgent);

function chromium(): ChromeApi {
  if (!isChromium || !chromeApi?.browsingData?.remove || !chromeApi.scripting || !chromeApi.tabs) {
    throw new Error('This browser does not support site-scoped data removal.');
  }
  return chromeApi;
}

function chromeCall<T>(invoke: (callback: (result: T) => void) => void): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  try {
    invoke((result) => {
      const error = chromeApi?.runtime.lastError;
      if (error) reject(new Error(error.message || 'Browser operation failed.'));
      else resolve(result);
    });
  } catch (error) {
    reject(error);
  }
  return promise;
}

export async function activeTab(): Promise<browser.tabs.Tab | undefined> {
  if (isFirefox || isSafari)
    return (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  const api = chromium();
  return (
    await chromeCall<browser.tabs.Tab[]>((callback) =>
      api.tabs.query({ active: true, currentWindow: true }, callback),
    )
  )[0];
}

export async function executeInTab(tabId: number, origin: string): Promise<void> {
  const options: browser.scripting.ScriptInjection<[string]> = {
    target: { tabId },
    args: [origin],
    // Firefox awaits the result, although the WebExtension types declare a void callback.
    func: (async (expectedOrigin: string) => {
      if (location.origin !== expectedOrigin)
        throw new Error('The tab navigated to a different site.');
      sessionStorage.clear();
      if ('caches' in globalThis) {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      }
      return true;
    }) as (expectedOrigin: string) => void,
  };
  const results = isFirefox
    ? await browser.scripting.executeScript(options)
    : await chromeCall<browser.scripting.InjectionResult[]>((callback) =>
        chromium().scripting.executeScript(options, callback),
      );
  if (results.length !== 1 || results[0].error || results[0].result !== true) {
    throw new Error('Could not clear session storage and Cache Storage in this tab.');
  }
}

export async function removeSiteData(url: URL): Promise<void> {
  if (isFirefox) {
    // Firefox matches quota-managed storage by host:port, but cookies by hostname.
    await browser.browsingData.remove(
      { hostnames: [url.host] },
      { localStorage: true, indexedDB: true },
    );
    await browser.browsingData.remove({ hostnames: [url.hostname] }, { cookies: true });
    return;
  }
  const api = chromium();
  // Chromium scopes storage by origin, but cookies by the origin's registrable domain.
  await chromeCall<void>((callback) =>
    api.browsingData.remove(
      { origins: [url.origin] },
      { localStorage: true, indexedDB: true, cookies: true },
      callback,
    ),
  );
}

export async function reloadTab(tabId: number): Promise<void> {
  if (isFirefox) return browser.tabs.reload(tabId, { bypassCache: true });
  await chromeCall<void>((callback) =>
    chromium().tabs.reload(tabId, { bypassCache: true }, callback),
  );
}
