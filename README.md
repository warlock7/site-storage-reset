# Site Storage Reset

A local extension for Zen, Firefox, Chrome, Edge, Brave, Opera and Safari that clears data for the site in the active tab. Production builds have no analytics or network requests.

The extension uses WXT and Vite. Source code lives in `src/`, including the popup in `src/entrypoints/` and the source icon in `src/assets/`. Ready-to-use icons live in `public/`; WXT writes browser-specific builds to `.output/`.

## Install

With Node.js 24 or newer and pnpm 10.10.0, run `pnpm install --frozen-lockfile` and `pnpm build` from this directory. The build generates Chrome, Firefox and Safari Manifest V3 extensions.

**Zen and Firefox:** Open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `.output/firefox-mv3/manifest.json`. Firefox removes temporary add-ons when the browser restarts. A permanent Firefox installation requires a signed add-on.

**Chrome, Edge, Brave and Opera:** Open your browser's extensions page, enable developer mode, choose **Load unpacked**, and select `.output/chrome-mv3/`. Chromium 119 or later is required.

Pin **Site Storage Reset** from your browser's extensions menu if desired. After changing the source, run `pnpm build` and reload the extension in your browser.

**Safari 18 or later:** Run `pnpm build:safari`. On recent macOS Safari versions, including Safari 27, enable **Safari → Settings → Advanced → Show features for web developers**, then open **Settings → Developer → Add Temporary Extension** and select `.output/safari-mv3/`. Enable the extension and grant access to the current site when prompted. Safari removes temporary extensions after 24 hours or when it quits.

The `.output` directory is hidden. On macOS, use **Command–Shift–G** in the file picker to enter its path.

If Safari does not expose the current page to the popup, enter its full address (for example, `http://localhost:3003`) and select **Allow access to this site**. The extension checks that Safari reports the same active origin before enabling the clear button. If Safari still cannot verify it, allow the extension for that site in Safari's website settings and reopen the popup.

For Safari versions without the temporary-extension option, or to package the extension in an app, run `pnpm package:safari` on macOS with Xcode fully set up. Open the generated project under `safari-build/` in Xcode, configure signing, and run the containing app. The packaging command refuses to overwrite an existing project.

## Development

Run `pnpm dev:chrome`, `pnpm dev:firefox`, or `pnpm dev:safari` to build and watch the selected target. Load the corresponding `.output/<browser>-mv3-dev/` directory manually; WXT is configured not to launch a browser automatically.

Development builds connect to a local WXT server for reloads and may request additional `tabs` and `scripting` permissions. Use the production builds in the installation instructions for normal browsing.

## Use

Open an HTTP(S) page, click the extension, check the displayed origin, and select **Clear and reload**. The extension clears available cookies, local storage, IndexedDB, session storage and Cache Storage, then reloads the tab. If anything fails, the popup reports an incomplete reset; some data may already have been deleted.

In Firefox, cookies are cleared by hostname and can affect other ports. Local storage and IndexedDB are matched by host and port; Firefox may clear both HTTP and HTTPS storage matching that host and port. Data in other containers may also be affected.

In Chromium browsers, storage is cleared for the current origin, but cookies are cleared for the entire registrable domain and can affect other subdomains and ports.

In Safari, storage is cleared only for the active origin and cookies are cleared only when accessible to the extension for the current site. **Partitioned cookies and parent-domain cookies not exposed by Safari's permissions may remain.** Safari's extension cookie API does not expose partition keys; see [WebKit bug 278439](https://bugs.webkit.org/show_bug.cgi?id=278439). Close other site tabs first: an open IndexedDB connection can block deletion, which the extension reports.

The extension directly clears session storage in the active tab; Firefox may also clear matching session storage in other tabs. Cache Storage is cleared only for the active origin. Other tabs can recreate data; close them first for a more complete reset. Service worker registrations and the browser's HTTP cache are not deleted.

Firefox and Chromium use `activeTab`, `scripting` and `browsingData`; the latter permission is broader than this extension's scoped operation. The separate Safari build uses `activeTab`, `scripting` and `cookies`, and requests HTTP and HTTPS access to the current host when you click **Clear and reload**. It does not request permanent access to all sites.

## Lint and format

```sh
pnpm lint          # Check with Oxlint
pnpm lint:fix      # Apply safe Oxlint fixes
pnpm format        # Format with Oxfmt
pnpm format:check  # Check formatting without changes
```

Run these commands from this directory after `pnpm install --frozen-lockfile`.

## Tests

The TypeScript integration tests use Node.js 24, Selenium, geckodriver, chromedriver, and headless Firefox and Chromium instances with fresh disposable profiles. They start local HTTP servers and do not touch your normal browser profile.

```sh
pnpm install --frozen-lockfile
pnpm test
```

Run these commands from this directory. `pnpm test` builds the extensions with WXT, type-checks the source and tests with `tsrs`, and runs the Firefox, Chromium and Safari-compatible API suites. The Safari cleanup suite uses real Chromium extension APIs and storage; it does not verify behavior in Safari. To select binaries explicitly, set `FIREFOX_BINARY` and `GECKODRIVER`, or `CHROME_BINARY` and `CHROMEDRIVER`. A matching Chrome for Testing build can be used when a branded browser blocks loading unpacked extensions through WebDriver.

To run the same Chromium regression cases against a specific installed browser, use `pnpm test:browser <browser>`. The run creates a disposable browser profile; it does not use your normal profile. Set the executable and matching WebDriver paths first:

| Browser | Executable variable | Driver variable |
| ------- | ------------------- | --------------- |
| Edge    | `EDGE_BINARY`       | `EDGEDRIVER`    |
| Brave   | `BRAVE_BINARY`      | `CHROMEDRIVER`  |
| Opera   | `OPERA_BINARY`      | `CHROMEDRIVER`  |
| Chrome  | `CHROME_BINARY`     | `CHROMEDRIVER`  |

For example, `env EDGE_BINARY=/path/to/edge EDGEDRIVER=/path/to/msedgedriver pnpm test:browser edge`. Use a ChromeDriver matching the Chromium version embedded in Brave or Opera; use an EdgeDriver matching Edge. The selected browser must permit WebDriver to load an unpacked extension. Missing or incompatible binaries fail the requested run rather than being silently skipped.

The cleanup tests install a temporary copy of the extension with host permissions limited to the local fixture servers and exercise real browser storage APIs. The Safari popup fallback tests run the popup with simulated Safari APIs; the tests do not verify the actual toolbar popup or its `activeTab` permission in Safari.
