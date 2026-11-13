'use strict';

// Configuration-only CI seed. It contains no gateway credentials or live adapter.
function officialProfile() {
  return {
    persona: 'Synthetic CI companion; no personal information.',
    qq_connection_mode: 'official',
    qq_default_delivery: 'official',
    official_owner_umo: 'synthetic-official:FriendMessage:Synthetic_OpenID',
    proactive_enabled: true,
    bili_enabled: true,
    discover_enabled: true,
    daily_limit: 0,
  };
}

module.exports = { officialProfile };
