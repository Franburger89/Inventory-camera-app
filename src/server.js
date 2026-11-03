import { configFromEnv, loadEnvFile } from './config.js';
import { createApp } from './app.js';

loadEnvFile();

let config;
try {
  config = configFromEnv();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const app = createApp(config);
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      event: 'listening',
      port: config.port,
      dataDir: config.dataDir,
    }),
  );
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
