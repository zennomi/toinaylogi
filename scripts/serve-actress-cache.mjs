import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const cachePath = '/actress-cache';
const prefix = `${cachePath}/`;
const allowedPath =
  /^(?:current\.json|status\.json|snapshots\/[a-z0-9-]{1,80}\/(?:snapshot\.json|images\/[a-z0-9-]{1,100}\.(?:jpg|jpeg|png|webp)))$/i;
const maxBytes = 8 * 1024 * 1024;
const contentTypes = {
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function sendError(response, code, message) {
  response.writeHead(code, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(message);
}

// Include the paths Next's URL parser and repeated-slash normalization can
// route to. Delegate only when none of those paths target the cache.
function routingPaths(rawPath) {
  const paths = new Set([rawPath]);
  for (const value of [rawPath, decodeURIComponent(rawPath)]) {
    paths.add(value);
    const url = new URL(value.startsWith('/') ? `http://local${value}` : value);
    paths.add(url.pathname);
    const collapsed = (value.startsWith('/') ? value : url.pathname).replace(
      /[\\/]+/g,
      '/',
    );
    paths.add(new URL(`http://local${collapsed}`).pathname);
  }
  return paths;
}

function sendFile(request, response, path, body) {
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
  const mutableManifest = path === 'current.json' || path === 'status.json';
  response.setHeader(
    'Cache-Control',
    mutableManifest ? 'no-store' : 'no-cache',
  );
  response.setHeader('Content-Type', contentTypes[extname(path).toLowerCase()]);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('ETag', etag);
  const candidates = String(request.headers['if-none-match'] ?? '').split(',');
  if (
    !mutableManifest &&
    candidates.some((candidate) => {
      const value = candidate.trim().replace(/^W\//, '');
      return value === '*' || value === etag;
    })
  ) {
    response.writeHead(304);
    response.end();
    return;
  }
  response.setHeader('Content-Length', body.length);
  response.writeHead(200);
  response.end(request.method === 'HEAD' ? undefined : body);
}

async function serveFile(root, path, request, response) {
  let file;
  try {
    const canonicalRoot = await realpath(root);
    const canonicalFile = await realpath(join(canonicalRoot, path));
    const within = relative(canonicalRoot, canonicalFile);
    if (
      isAbsolute(within) ||
      within === '..' ||
      within.startsWith(`..${sep}`)
    ) {
      return sendError(response, 404, 'Not found');
    }
    file = await open(
      canonicalFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      return sendError(response, 404, 'Not found');
    }
    // A bounded read also handles an in-place edit growing the file after stat.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size)
      return sendError(response, 503, 'Cache file changed; retry');
    sendFile(request, response, path, buffer.subarray(0, length));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) {
      sendError(response, 404, 'Not found');
    } else {
      console.error('[actress-cache] Read failed:', error);
      sendError(response, 500, 'Cache unavailable');
    }
  } finally {
    await file?.close().catch((error) => {
      console.error('[actress-cache] Close failed:', error);
    });
  }
}

export function createActressCacheHandler(directory) {
  const root = resolve(directory);
  return async function serveActressCache(request, response) {
    const rawPath = (request.url ?? '').split('?')[0];
    let paths;
    try {
      paths = routingPaths(rawPath);
    } catch {
      sendError(response, 400, 'Invalid URL');
      return true;
    }
    if (
      ![...paths].some((path) => path.startsWith(prefix) || path === cachePath)
    )
      return false;
    const path = rawPath.slice(prefix.length);
    if (
      !rawPath.startsWith(prefix) ||
      paths.size !== 1 ||
      !allowedPath.test(path)
    ) {
      sendError(response, 404, 'Not found');
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      sendError(response, 405, 'Method not allowed');
    } else {
      await serveFile(root, path, request, response);
    }
    return true;
  };
}
