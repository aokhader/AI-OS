/** Test-only entry point so the runner's integration tests can host the mock app in-process. */
export { type AppConfig, configFromEnv } from './config.js';
export { type Bank, createBank, formatMoney } from './data.js';
export { createApp } from './server.js';
export { type VariantConfig, type VariantKey, variants } from './variants.js';
