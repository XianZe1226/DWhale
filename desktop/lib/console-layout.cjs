'use strict';

// AstrBot's reusable config row uses viewport-based sm=6 columns. The desktop
// can leave that row narrow beside either sidebar, even in a wide viewport.
module.exports = `
.config-row {
  container-name: dwhale-config-row;
  container-type: inline-size;
}
@container dwhale-config-row (max-width: 560px) {
  .config-row > .property-info,
  .config-row > .config-input {
    flex: 0 0 100%;
    max-width: 100%;
    min-width: 0;
  }
  .config-row > .property-info {
    padding-right: 0 !important;
  }
  .config-row > .property-info :is(.property-name, .property-hint) {
    overflow-wrap: anywhere;
  }
  .config-row > .property-info .property-hint__content--linked {
    flex-wrap: wrap;
    white-space: normal;
  }
  .config-row > .config-input {
    justify-content: flex-start !important;
    padding-top: 10px !important;
  }
  .config-row > .config-input > :not(.config-field--full-width):not(.v-switch) {
    max-width: 100% !important;
  }
}
`;
