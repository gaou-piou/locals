import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

export type FixtureServer = { origin: string; close: () => Promise<void> };

/** Serves e2e/fixtures over HTTP. A `?csp=<policy>` query adds a CSP header. */
export async function startServer(): Promise<FixtureServer> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/echo") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(req.headers));
      return;
    }
    const file = path.join(FIXTURES, path.basename(url.pathname));
    try {
      const body = await readFile(file);
      const csp = url.searchParams.get("csp");
      res.writeHead(200, {
        "content-type": file.endsWith(".html") ? "text/html" : "application/octet-stream",
        ...(csp ? { "content-security-policy": csp } : {}),
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://localhost:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
