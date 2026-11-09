import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

export type FixtureServer = {
  origin: string;
  requests: string[];
  /** "<path> <sec-fetch-dest>": a page's script load is "script", the extension worker's own fetch is "empty". */
  log: string[];
  close: () => Promise<void>;
};

const JQ = (v: string) => readFile(`dist/libs/jquery/${v}/dist/jquery.min.js`);
/** Copies a site might host under the name jquery-3.7.1.min.js. */
const BYNAME: Record<string, () => Promise<Buffer | string>> = {
  same: () => JQ("3.7.1"),
  older: () => JQ("3.6.4"),
  patched: async () => `${await JQ("3.7.1")}\n;window.PATCHED = true;`,
};

/** Serves e2e/fixtures over HTTP. A `?csp=<policy>` query adds a CSP header. */
export async function startServer(): Promise<FixtureServer> {
  const requests: string[] = [];
  const log: string[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(url.pathname);
    log.push(`${url.pathname} ${req.headers["sec-fetch-dest"] ?? "-"}`);
    // /byname/<variant>.html loads /byname/<variant>/jquery-3.7.1.min.js, named after the library and version
    const page = url.pathname.match(/^\/byname\/(\w+)\.html$/);
    if (page && BYNAME[page[1]]) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>${page[1]}</title><script src="/byname/${page[1]}/jquery-3.7.1.min.js"></script>`);
      return;
    }
    const lib = url.pathname.match(/^\/byname\/(\w+)\/jquery-3\.7\.1\.min\.js$/);
    if (lib && BYNAME[lib[1]]) {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(await BYNAME[lib[1]]());
      return;
    }
    // a site hosting its own copy of jQuery 3.7.1 (byte-identical to the bundled file)
    if (url.pathname === "/vendor/jquery.min.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(await readFile("dist/libs/jquery/3.7.1/dist/jquery.min.js"));
      return;
    }
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
    requests,
    log,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
