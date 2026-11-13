'use strict';
// GitHub Actions supplies an empty value when an optional secret is absent.
// electron-builder treats an empty CSC_LINK as the working directory.
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD']) {
  if (process.env[name] === '') delete process.env[name];
}
// A local ad-hoc signature lets Apple Silicon launch the app. It is not a
// trusted Developer ID signature or notarization. Real certificates are opt-in.
const bridge = process.env.DSWALE_BRIDGE === '1';
const displayName = bridge ? 'DSWhale' : 'DWhale';
const assetPrefix = bridge ? 'DSWhale' : 'DWhale';
const config = {
  "appId": "dev.dswhale.desktop",
  "productName": displayName,
  "electronVersion": "45.1.0",
  "asar": true,
  // Keep the GUI launchable when a parent process exports Electron/Node flags.
  "electronFuses": {
    "runAsNode": false,
    "enableNodeOptionsEnvironmentVariable": false,
    "enableNodeCliInspectArguments": false
  },
  "npmRebuild": false,
  "buildDependenciesFromSource": false,
  "directories": {
    "output": "desktop-dist",
    "buildResources": "desktop/assets"
  },
  "files": [
    "desktop/main.cjs",
    "desktop/preload.cjs",
    "desktop/lib/runtime.cjs",
    "desktop/lib/runtime-lock.cjs",
    "desktop/lib/update-protocol.cjs",
    "desktop/lib/update-chain.cjs",
    "desktop/lib/appearance.cjs",
    "desktop/lib/window-chrome.cjs",
    "desktop/lib/branding.cjs",
    "desktop/lib/mac-migration.cjs",
    "desktop/lib/security.cjs",
    "desktop/lib/official-connection.cjs",
    "desktop/lib/status-cache.cjs",
    "desktop/lib/services.cjs",
    "desktop/lib/extensions.cjs",
    "desktop/lib/app-updater.cjs",
    "desktop/lib/installer.cjs",
    "desktop/lib/update-scheduler.cjs",
    "desktop/lib/network.cjs",
    "desktop/lib/operations.cjs",
    "desktop/lib/workspace.cjs",
    "desktop/lib/preferences.cjs",
    "desktop/lib/diagnostics.cjs",
    "desktop/lib/release-trust.json",
    "desktop/lib/tool-assets.json",
    "desktop/ui/index.html",
    "desktop/ui/app.js",
    "desktop/ui/model.js",
    "desktop/ui/style.css",
    "desktop/ui/background.png",
    "desktop/ui/dwhale-hero.png",
    "desktop/ui/dwhale-whale.png",
    "desktop/assets/icon.png",
    "desktop/assets/icons/**/*",
    "desktop/assets/trayTemplate.png",
    "desktop/assets/trayTemplate@2x.png",
    "package.json",
    "!**/*.test.*",
    "!**/.DS_Store",
    "!**/node_modules/**"
  ],
  "extraResources": [
    {
      "from": "desktop-resources/backend",
      "to": "backend"
    },
    {
      "from": "desktop-resources/backend-manifest.json",
      "to": "backend-manifest.json"
    },
    {
      "from": "THIRD_PARTY_NOTICES.md",
      "to": "THIRD_PARTY_NOTICES.md"
    },
    {
      "from": "LICENSE",
      "to": "LICENSE"
    }
  ],
  "mac": {
    "target": [
      {
        "target": "dmg",
        "arch": [
          "arm64"
        ]
      }
    ],
    "category": "public.app-category.social-networking",
    "minimumSystemVersion": "13.0",
    "icon": "desktop/assets/icon.icns",
    "artifactName": assetPrefix + '-${version}-macOS-arm64.${ext}',
    "hardenedRuntime": false,
    "entitlements": "desktop/assets/entitlements.mac.plist",
    "entitlementsInherit": "desktop/assets/entitlements.mac.plist",
    "notarize": false
  },
  "dmg": {
    "title": displayName + " ${version}"
  },
  "win": {
    "target": [
      {
        "target": "nsis",
        "arch": [
          "x64"
        ]
      }
    ],
    "icon": "desktop/assets/icon.ico",
    "artifactName": assetPrefix + '-${version}-Windows-x86_64-setup.${ext}',
    "requestedExecutionLevel": "asInvoker"
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowElevation": false,
    "allowToChangeInstallationDirectory": false,
    "deleteAppDataOnUninstall": false,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true
  },
  "linux": {
    "target": [
      {
        "target": "deb",
        "arch": [
          "x64"
        ]
      },
      {
        "target": "tar.gz",
        "arch": [
          "x64"
        ]
      }
    ],
    "category": "Network",
    "icon": "desktop/assets/icons",
    "artifactName": assetPrefix + '-${version}-Linux-x86_64.${ext}',
    "maintainer": displayName + " Contributors",
    "executableName": "dswhale",
    "synopsis": "QQ companion with shared memory and video experiences",
    "desktop": {
      "entry": {
        "StartupWMClass": displayName,
        "Keywords": "QQ;AstrBot;Companion;"
      }
    }
  },
  "deb": {
    "depends": [
      "libgtk-3-0",
      "libnss3",
      "libxss1",
      "libxtst6",
      "libatspi2.0-0",
      "libdrm2",
      "libgbm1",
      "fonts-noto-cjk",
      "libasound2 | libasound2t64"
    ]
  },
  "publish": null
};
const hasCertificate = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
config.mac.identity = hasCertificate ? undefined : '-';
config.mac.hardenedRuntime = hasCertificate;
if (process.platform === 'darwin' && hasCertificate) config.forceCodeSigning = true;
module.exports = config;
