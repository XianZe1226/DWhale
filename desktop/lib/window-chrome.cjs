'use strict';
// Shared window/embedded-console geometry. Renderer receives these values in state.chrome.
const SIDEBAR_WIDTH = 256;
const PANEL_TOOLBAR_HEIGHT = 52;
const MIN_WIDTH = 980;
const MIN_HEIGHT = 700;
const PANEL_BREAKPOINT = 1220;

function panelBounds({ width, height }) {
  const sidebar = width >= PANEL_BREAKPOINT ? SIDEBAR_WIDTH : 0;
  return { x: sidebar, y: PANEL_TOOLBAR_HEIGHT, width: Math.max(0, width - sidebar), height: Math.max(0, height - PANEL_TOOLBAR_HEIGHT) };
}

function chromeFor(platform) {
  return { platform, immersive: platform === 'darwin' || platform === 'win32', sidebarWidth: SIDEBAR_WIDTH, toolbarHeight: PANEL_TOOLBAR_HEIGHT, minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT, breakpoint: PANEL_BREAKPOINT };
}

function titleBarOverlay(dark) {
  return {
    color: dark ? '#1b2333' : '#eef3fa',
    symbolColor: dark ? '#dbe6f6' : '#475569',
    height: 40,
  };
}

function browserWindowOptions(platform, release = '') {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } };
  if (platform === 'win32') {
    const options = { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(false) };
    const build = Number(String(release).split('.')[2]) || 0;
    if (build >= 22621) options.backgroundMaterial = 'mica';
    return options;
  }
  return {};
}

module.exports = { SIDEBAR_WIDTH, PANEL_TOOLBAR_HEIGHT, MIN_WIDTH, MIN_HEIGHT, PANEL_BREAKPOINT, panelBounds, chromeFor, browserWindowOptions, titleBarOverlay };
