import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  imports: false,
  webExt: { disabled: true },
  manifest: ({ browser }) => ({
    name: 'Site Storage Reset',
    description: 'Clear storage for the current site on request.',
    ...(browser === 'safari'
      ? {
          browser_specific_settings: { safari: { strict_min_version: '18' } },
          permissions: ['activeTab', 'scripting', 'cookies'],
          optional_host_permissions: ['http://*/*', 'https://*/*'],
        }
      : {
          minimum_chrome_version: '119',
          browser_specific_settings: {
            gecko: { id: 'site-storage-reset@local.dev', strict_min_version: '109.0' },
          },
          permissions: ['activeTab', 'browsingData', 'scripting'],
        }),
    icons: { 48: 'icon48.png', 128: 'icon128.png' },
    action: {
      default_title: 'Reset site storage',
      default_icon: { 16: 'icon16.png', 32: 'icon32.png' },
    },
  }),
});
