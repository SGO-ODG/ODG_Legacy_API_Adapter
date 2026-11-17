import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import restwsRouter from './routes/restws';
import calculatorRouter from './routes/calculator';
import { isDebugEnabled } from './config/env';

export function createApp(): express.Application {
  const app = express();

  // Accept the raw POST body regardless of Content-Type.
  // Mirrors PHP's file_get_contents("php://input") — legacy clients send XML
  // with various or incorrect Content-Type headers (e.g. application/x-www-form-urlencoded).
  app.use(express.raw({ type: '*/*', limit: '1mb' }));

  // Development only — static HTML/CSS/JS test pages for manual smoke testing.
  // Azure: this path is not needed in production. Consider restricting access or
  // removing the api-tester folder from the deployment package entirely.
  app.use('/api-tester', express.static(path.join(__dirname, '..', 'api-tester')));

  // Health check — no auth required.
  // Azure: configure this as the App Service health check probe path.
  // Terraform: azurerm_linux_web_app → site_config { health_check_path = "/health" }
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Debug: log incoming legacy request URL
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (isDebugEnabled()) {
      console.log(`[LEGACY REQ] ${req.method} ${req.originalUrl}`);
    }
    next();
  });

  // Legacy API routes
  app.use('/restws', restwsRouter);
  app.use('/calculator', calculatorRouter);

  // 404 handler for unregistered paths
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Global error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // Log full stack in all environments so Application Insights captures actionable traces.
    // The client only ever receives the sanitized 500 body below — the stack is never exposed.
    console.error('Unhandled error:', err.stack ?? err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
