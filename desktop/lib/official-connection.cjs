'use strict';
function snapshot({ platforms = [], bindings = {}, boundPlatformIds = {}, health = {} } = {}) {
  const candidates = platforms.filter(item => item?.type === 'qq_official');
  const boundId = boundPlatformIds.official || '';
  const matches = boundId ? candidates.filter(item => item.id === boundId) : candidates;
  const target = matches.length === 1 ? matches[0] : null;
  const targetIssue = target ? '' : matches.length > 1 ? 'ambiguous' : boundId ? 'missing-bound' : 'missing';
  const entry = health.channels?.official || health.official || {};
  const platformEnabled = target?.enable === true;
  const configured = target?.configured === true;
  const protocolConnected = Boolean(platformEnabled && configured && !targetIssue && entry.protocolConnected === true);
  return { channels: [{ channel: 'official', label: 'QQ 官方机器人', platformId: target?.id || '',
    platformEnabled, configured, bound: bindings.official === true, targetIssue,
    platformCandidates: candidates, protocolConnected,
    health: !platformEnabled ? 'disabled' : protocolConnected ? 'connected' : entry.state || 'unknown' }] };
}
module.exports = { snapshot };
