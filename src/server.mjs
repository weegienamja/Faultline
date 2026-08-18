import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnose } from "./engine/diagnose.mjs";
import { incidents } from "./engine/incidents.mjs";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT || 3000);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function bodyFrom(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/incidents") {
      return json(res, 200, incidents.map(incident => ({
        ...incident,
        diagnosis: diagnose(incident.metrics)
      })));
    }

    if (req.method === "POST" && url.pathname === "/api/diagnose") {
      const payload = await bodyFrom(req);
      return json(res, 200, diagnose(payload));
    }

    const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const safePath = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = join(root, safePath);

    if (!filePath.startsWith(root)) return json(res, 403, { error: "Forbidden" });

    try {
      const data = await readFile(filePath);
      res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream" });
      res.end(data);
    } catch {
      const html = await readFile(join(root, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    }
  } catch (error) {
    json(res, 400, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Faultline listening on http://localhost:${port}`);
});
