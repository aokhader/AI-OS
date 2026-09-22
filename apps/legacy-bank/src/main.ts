import { configFromEnv } from './config.js';
import { createApp } from './server.js';

const config = configFromEnv();
const app = createApp(config);

app.listen(config.port, () => {
  console.log(
    `[legacy-bank] ${config.variant.institution} (${config.variant.product} ${config.variant.productVersion}) on http://localhost:${config.port}  sign in as ${config.user}`,
  );
});
