import { validateEnv } from './config/env';
import { createApp } from './app';

const env = validateEnv();
const app = createApp();

app.listen(env.PORT, () => {
  console.warn(`ODG Legacy API Adapter listening on port ${env.PORT} [${env.NODE_ENV}]`);
});
