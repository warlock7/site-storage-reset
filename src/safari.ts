function hostPatterns(url: URL): string[] {
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    throw new Error('Only HTTP and HTTPS sites can be reset.');
  }
  return [`http://${url.hostname}/*`, `https://${url.hostname}/*`];
}

export async function requestSafariHostPermissions(url: URL): Promise<boolean> {
  const origins = hostPatterns(url);
  if (typeof browser === 'undefined' || !browser.permissions?.request) {
    throw new Error('This browser cannot request site permissions.');
  }
  return browser.permissions.request({ origins });
}

function applicableCookie(cookie: browser.cookies.Cookie, hostname: string): boolean {
  // Partitioned cookies cannot reliably be enumerated or removed in Safari.
  if ('partitionKey' in cookie && cookie.partitionKey != null) return false;
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  return hostname === domain || (!cookie.hostOnly && hostname.endsWith(`.${domain}`));
}

async function checkTabOrigin(tabId: number, origin: string): Promise<void> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.url || new URL(tab.url).origin !== origin) {
    throw new Error('The tab navigated to a different site.');
  }
}

export async function resetSafariSite(tabId: number, url: URL): Promise<void> {
  const origins = hostPatterns(url);
  if (
    typeof browser === 'undefined' ||
    !browser.permissions?.contains ||
    !browser.scripting?.executeScript ||
    !browser.cookies?.getAll ||
    !browser.cookies?.remove ||
    !browser.cookies?.getAllCookieStores ||
    !browser.tabs?.get ||
    !browser.tabs?.reload
  ) {
    throw new Error('This browser does not support site-scoped storage removal.');
  }
  if (!(await browser.permissions.contains({ origins }))) {
    throw new Error('Site permissions are required to remove site data.');
  }
  await checkTabOrigin(tabId, url.origin);
  const stores = (await browser.cookies.getAllCookieStores()).filter((store) =>
    store.tabIds.includes(tabId),
  );
  if (stores.length !== 1) throw new Error('Could not identify the tab’s cookie store.');
  const storeId = stores[0].id;

  const results = await browser.scripting.executeScript({
    target: { tabId },
    args: [url.origin],
    // The extension APIs await the injected async function despite the Firefox type declaration.
    func: (async (expectedOrigin: string) => {
      try {
        if (location.origin !== expectedOrigin)
          throw new Error('The tab navigated to a different site.');
        if (
          typeof indexedDB.databases !== 'function' ||
          (isSecureContext && !('caches' in globalThis))
        ) {
          throw new Error('This site’s storage cannot be fully enumerated.');
        }
        localStorage.clear();
        sessionStorage.clear();
        if ('caches' in globalThis) {
          for (const name of await caches.keys()) {
            if (!(await caches.delete(name))) throw new Error(`Could not delete cache: ${name}`);
          }
        }
        for (const database of await indexedDB.databases()) {
          if (database.name === undefined) throw new Error('An IndexedDB database has no name.');
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          const request = indexedDB.deleteDatabase(database.name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error ?? new Error('IndexedDB deletion failed.'));
          request.onblocked = () =>
            reject(new Error(`IndexedDB deletion blocked: ${database.name}`));
          await promise;
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }) as (expectedOrigin: string) => void,
  });
  const result = results[0]?.result as { ok: boolean; message?: string } | undefined;
  if (results.length !== 1 || results[0].error || !result?.ok) {
    throw new Error(result?.message ?? 'Could not clear site storage in this tab.');
  }

  await checkTabOrigin(tabId, url.origin);
  const hostname = url.hostname.toLowerCase();
  const matchingCookies = async () =>
    (await browser.cookies.getAll({ storeId })).filter((cookie) =>
      applicableCookie(cookie, hostname),
    );
  let cookies = await matchingCookies();
  while (cookies.length) {
    const cookie = cookies[0];
    const target = new URL(`${cookie.secure ? 'https:' : 'http:'}//${url.host}/`);
    target.pathname = cookie.path;
    if (target.pathname !== cookie.path) throw new Error('Cannot safely address a cookie path.');
    const removed = await browser.cookies.remove({
      url: target.href,
      name: cookie.name,
      storeId,
    });
    if (!removed) throw new Error(`Could not remove cookie: ${cookie.name}`);
    const remaining = await matchingCookies();
    if (remaining.length >= cookies.length) {
      throw new Error(`Could not confirm cookie removal: ${cookie.name}`);
    }
    cookies = remaining;
  }
  await checkTabOrigin(tabId, url.origin);
  await browser.tabs.reload(tabId, { bypassCache: true });
}
