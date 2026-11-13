'use strict';
// Shared window/embedded-console geometry. Renderer receives these values in state.chrome.
const SIDEBAR_WIDTH = 256;
const PANEL_TOOLBAR_HEIGHT = 52;
const MIN_WIDTH = 980;
const MIN_HEIGHT = 700;
const PANEL_BREAKPOINT = 1220;
const TITLEBAR_HEIGHT = 40;

function panelBounds({ width, height }) {
  const sidebar = width >= PANEL_BREAKPOINT ? SIDEBAR_WIDTH : 0;
  return { x: sidebar, y: PANEL_TOOLBAR_HEIGHT, width: Math.max(0, width - sidebar), height: Math.max(0, height - PANEL_TOOLBAR_HEIGHT) };
}

function chromeFor(platform) {
  const immersive = platform === 'darwin' || platform === 'win32';
  return {
    platform, immersive, sidebarWidth: SIDEBAR_WIDTH, toolbarHeight: PANEL_TOOLBAR_HEIGHT,
    titlebarHeight: immersive ? TITLEBAR_HEIGHT : 0,
    controlsInset: platform === 'win32' ? 150 : 0,
    controlsLeftInset: platform === 'darwin' ? 80 : 0,
    minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT, breakpoint: PANEL_BREAKPOINT,
  };
}

function titleBarOverlay(dark) {
  return {
    color: '#00000000',
    symbolColor: dark ? '#dbe6f6' : '#475569',
    height: TITLEBAR_HEIGHT,
  };
}

function browserWindowOptions(platform, release = '', dark = false) {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } };
  if (platform === 'win32') {
    const options = { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(dark) };
    const build = Number(String(release).split('.')[2]) || 0;
    if (build >= 22621) options.backgroundMaterial = 'mica';
    return options;
  }
  return {};
}

module.exports = { SIDEBAR_WIDTH, PANEL_TOOLBAR_HEIGHT, MIN_WIDTH, MIN_HEIGHT, PANEL_BREAKPOINT, panelBounds, chromeFor, browserWindowOptions, titleBarOverlay };
