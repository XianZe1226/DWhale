'use strict';

// The appId and legacy disk identity are compatibility surfaces. The display
// name changed to DWhale, but installed data, registry values and existing
// Windows directories must keep working.
const LEGACY_MAC_NAME = 'DSWhale.app';
const CURRENT_MAC_NAME = 'DWhale.app';
const MINIMUM_LEGACY_BUNDLE = 'dev.dswhale.desktop';

function macBundleCandidates(home) {
  const roots = ['/Applications', home ? `${home}/Applications` : null].filter(Boolean);
  return roots.flatMap(root => [
    { name: CURRENT_MAC_NAME, path: `${root}/${CURRENT_MAC_NAME}`, legacy: false },
    { name: LEGACY_MAC_NAME, path: `${root}/${LEGACY_MAC_NAME}`, legacy: true },
  ]);
}

function sameBundlePath(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.replace(/\/+$/, '').toLowerCase() === right.replace(/\/+$/, '').toLowerCase();
}

module.exports = { LEGACY_MAC_NAME, CURRENT_MAC_NAME, MINIMUM_LEGACY_BUNDLE, macBundleCandidates, sameBundlePath };
