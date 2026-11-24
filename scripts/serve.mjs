import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createActressCacheHandler } from './serve-actress-cache.mjs';

export function parseServerOptions(
  args = process.argv.slice(2),
  env = process.env,
) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', short: 'p' },
      hostname: { type: 'string', short: 'H' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const rawPort = values.port ?? env.PORT ?? '3000';
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Port must be an integer between 0 and 65535');
  }
  const hostname = values.hostname ?? '127.0.0.1';
  if (!hostname.trim()) throw new Error('Hostname must not be empty');
  return { port, hostname, help: values.help ?? false };
}

async function startServer({ port, hostname }) {
  // This entry point serves a production build; development uses next dev.
  process.env.NODE_ENV = 'production';
  const { default: next } = await import('next');
  const server = createServer();
  const app = next({ dev: false, hostname, port, httpServer: server });
  const serveCache = createActressCacheHandler(
    join(process.cwd(), 'public', 'actress-cache'),
  );
  try {
    await app.prepare();
    const handle = app.getRequestHandler();
    server.on('request', (request, response) => {
      void (async () => {
        if (!(await serveCache(request, response)))
          await handle(request, response);
      })().catch((error) => {
        console.error('[server] Request failed:', error);
        if (!response.headersSent) {
          response.writeHead(500, { 'Cache-Control': 'no-store' });
          response.end('Internal server error');
        } else {
          response.destroy();
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, hostname, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    server,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await app.close();
    },
  };
}

async function main() {
  const options = parseServerOptions();
  if (options.help) {
    console.log('Usage: pnpm start [--port 3000] [--hostname 127.0.0.1]');
    return;
  }
  const running = await startServer(options);
  const address = running.server.address();
  console.log(`> Ready on http://${options.hostname}:${address.port}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    try {
      await running.close();
      process.exit(0);
    } catch (error) {
      console.error('[server] Shutdown failed:', error);
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error('[server] Startup failed:', error);
    process.exit(1);
  });
}
