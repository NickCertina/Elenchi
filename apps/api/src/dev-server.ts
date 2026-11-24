import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveEnv } from "./env";
import { createSqlArenaStore } from "./store";
import { handleApiRequest } from "./index";

function loadDotEnvIfPresent(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return out;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    out[key] = val;
  }
  return out;
}

const dotEnv = {
  ...loadDotEnvIfPresent(path.join(process.cwd(), ".env")),
  ...loadDotEnvIfPresent(path.join(process.cwd(), ".env.local")),
};
const env = resolveEnv({ ...dotEnv, ...process.env });

const dataDir = path.join(process.cwd(), ".data");
fs.mkdirSync(dataDir, { recursive: true });
const sqlite = new DatabaseSync(path.join(dataDir, "elenchi.sqlite"));
const store = createSqlArenaStore({
  exec(sql) {
    sqlite.exec(sql);
  },
  query(sql, params = []) {
    const stmt = sqlite.prepare(sql);
    const trimmed = sql.trimStart().toUpperCase();
    if (trimmed.startsWith("SELECT")) {
      return stmt.all(...(params as Array<string | number | null>)) as Array<
        Record<string, unknown>
      >;
    }
    stmt.run(...(params as Array<string | number | null>));
    return [];
  },
});

const webDir = path.join(process.cwd(), "apps", "web");
const PORT = Number(process.env.PORT ?? 8788);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://rpc.mainnet.chain.robinhood.com https://rpc.testnet.chain.robinhood.com; frame-ancestors 'none'; base-uri 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function resolveStaticRoute(pathname: string): string | null {
  if (pathname === "/" || pathname === "/index.html") return path.join(webDir, "index.html");
  if (pathname === "/arena" || pathname === "/arena.html") return path.join(webDir, "arena.html");
  if (pathname === "/run" || pathname === "/run.html" || pathname.startsWith("/run/")) {
    return path.join(webDir, "run.html");
  }
  if (pathname === "/protocol" || pathname === "/protocol.html") return path.join(webDir, "protocol.html");
  if (pathname === "/token" || pathname === "/token.html") return path.join(webDir, "token.html");
  if (pathname === "/docs" || pathname === "/docs.html") return path.join(webDir, "docs.html");
  if (pathname === "/privacy" || pathname === "/privacy.html") return path.join(webDir, "privacy.html");

  const safeRel = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const candidate = path.join(webDir, safeRel);
  if (!candidate.startsWith(webDir)) return null;
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? `127.0.0.1:${PORT}`;
    const fullUrl = new URL(req.url ?? "/", `http://${host}`);

    if (fullUrl.pathname.startsWith("/api/") || fullUrl.pathname === "/skill.md") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const bodyBuf = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) headers.set(k, v.join(", "));
        else if (typeof v === "string") headers.set(k, v);
      }
      if (!headers.has("x-forwarded-for") && req.socket.remoteAddress) {
        headers.set("x-forwarded-for", req.socket.remoteAddress);
      }
      const fetchReq = new Request(fullUrl.toString(), {
        method: req.method ?? "GET",
        headers,
        body:
          req.method === "GET" || req.method === "HEAD" || bodyBuf.length === 0
            ? undefined
            : bodyBuf,
      });

      const apiRes = await handleApiRequest(fetchReq, env, store);

      res.statusCode = apiRes.status;
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        res.setHeader(k, v);
      }
      apiRes.headers.forEach((val, key) => {
        res.setHeader(key, val);
      });
      if (apiRes.body && (apiRes.headers.get("content-type") || "").includes("text/event-stream")) {
        res.flushHeaders();
        const reader = apiRes.body.getReader();
        req.on("close", () => {
          reader.cancel().catch(() => {});
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
        return;
      }
      const resBuf = Buffer.from(await apiRes.arrayBuffer());
      res.end(resBuf);
      return;
    }

    const filePath = resolveStaticRoute(fullUrl.pathname);
    if (!filePath) {
      res.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const fileBuf = fs.readFileSync(filePath);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": contentType,
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(fileBuf);
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : "Unexpected server error",
      })
    );
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`ELENCHI local server listening on http://127.0.0.1:${PORT}`);
});
