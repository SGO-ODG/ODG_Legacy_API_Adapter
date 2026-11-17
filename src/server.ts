import { validateEnv } from './config/env';
import { createApp } from './app';

const env = validateEnv();
const app = createApp();

// Azure App Service sets the PORT environment variable automatically (default 8080).
// Terraform: azurerm_linux_web_app → app_settings { PORT = "8080" }
// Startup command: node dist/server.js
// Terraform: azurerm_linux_web_app → site_config { app_command_line = "node dist/server.js" }
app.listen(env.PORT, () => {
  console.warn(`ODG Legacy API Adapter listening on port ${env.PORT} [${env.NODE_ENV}]`);
});
