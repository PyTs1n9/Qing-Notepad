/**
 * Zero-dependency static server for local preview: `npm run serve`.
 * The published site is plain files, so this only exists to avoid needing a
 * build step or an extra dev dependency on this branch.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";

  const target = resolve(root, `.${pathname}`);
  if (!target.startsWith(root.endsWith(sep) ? root : root + sep)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("403");
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      response.writeHead(302, { location: `${pathname}/` }).end();
      return;
    }
    const body = await readFile(target);
    response
      .writeHead(200, {
        "content-type": TYPES[extname(target)] ?? "application/octet-stream",
        "cache-control": "no-store",
      })
      .end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`碎片墙 preview: http://127.0.0.1:${port}/`);
});
