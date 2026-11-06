#!/usr/bin/env node
/**
 * CPE Pilot — 本地网关
 *
 * 浏览器直接 POST http://192.168.6.1/ubus 会被跨域预检拦掉（OpenWrt 不开 CORS），
 * 所以这个零依赖小服务做两件事：
 *   1. 把 panel/ 静态文件发到 0.0.0.0:8090；
 *   2. 把同源 POST /ubus 原样转发给路由器（目标由请求头 X-CPE-Router 指定）。
 *
 * 用法：node server.mjs  →  手机/电脑浏览器打开 http://<本机IP>:8080
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "public");
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || "0.0.0.0";
const DEFAULT_ROUTER = process.env.ROUTER || "192.168.6.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const isPrivateHost = (host) => {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (/\.(lan|local|home\.arpa)$/.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
};

function routerUrl(raw) {
  const value = String(raw || DEFAULT_ROUTER).trim();
  if (!value) throw new Error("缺少路由器地址");
  if (!/^[A-Za-z0-9.:\[\]-]+$/.test(value)) throw new Error("路由器地址不合法");
  const withProto = /^https?:\/\//i.test(value) ? value : "http://" + value;
  const url = new URL(withProto);
  if (!isPrivateHost(url.hostname)) throw new Error("只允许访问内网地址");
  url.pathname = "/ubus";
  url.search = "";
  return url.toString();
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

async function proxyUbus(req, res) {
  let target;
  try {
    target = routerUrl(req.headers["x-cpe-router"]);
  } catch (err) {
    send(res, 400, JSON.stringify({ error: { message: err.message } }), { "Content-Type": "application/json" });
    return;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error("请求体过大");
      chunks.push(chunk);
    }
  } catch (err) {
    send(res, 413, JSON.stringify({ error: { message: err.message } }), { "Content-Type": "application/json" });
    return;
  }
  try {
    const upstream = await postToRouter(target, Buffer.concat(chunks));
    send(res, upstream.status, upstream.body, { "Content-Type": upstream.type || "application/json; charset=utf-8" });
  } catch (err) {
    const message = err?.name === "TimeoutError" ? "路由器 15 秒没有响应" : "连不上路由器 /ubus";
    send(res, 502, JSON.stringify({ error: { code: "gateway", message, detail: String(err?.message || err) } }), {
      "Content-Type": "application/json",
    });
  }
}

/**
 * 手机常常把移动数据当默认网络（WiFi 因无法访问 Google 探测被判定“无互联网”），
 * 这时普通 fetch 会把发往 192.168.6.1 的包丢给 4G。这里按路由器网段找到本机
 * WiFi 地址并用它做源地址，强制走局域网。
 */
function interfaceFor(hostname) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return undefined;
  const prefix = hostname.split(".").slice(0, 3).join(".") + ".";
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if ((list || []).some((n) => n && n.family === "IPv4" && !n.internal && n.address.startsWith(prefix))) return name;
  }
  return undefined;
}

/**
 * 安卓把移动数据设为默认网络时，仅换源地址仍会被策略路由丢给 4G；
 * 用 curl --interface 绑定出网卡才稳。PC 上 curl 同样可用，退出码兜底走原生请求。
 */
function postWithCurl(target, body) {
  return new Promise((resolve, reject) => {
    const host = new URL(target).hostname;
    const iface = interfaceFor(host);
    const curl = process.env.CPE_CURL || "curl";
    const args = ["-s", "-m", "15", "-i", "-X", "POST", target, "-H", "Content-Type: application/json", "-H", "Accept: application/json", "--data-binary", "@-"];
    if (iface) args.splice(0, 0, "--interface", iface);
    const child = spawn(curl, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    const errs = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => errs.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(chunks).toString("utf8");
      if (!out) {
        reject(new Error("curl 退出码 " + code + " " + Buffer.concat(errs).toString("utf8").slice(0, 120)));
        return;
      }
      const split = out.indexOf("\r\n\r\n");
      const head = split >= 0 ? out.slice(0, split) : "";
      const payload = split >= 0 ? out.slice(split + 4) : out;
      const status = Number((head.match(/^HTTP\/\d\.\d (\d+)/) || [])[1] || 502);
      const type = (head.match(/^content-type:\s*(.*)$/im) || [])[1];
      resolve({ status, type, body: payload });
    });
    child.stdin.end(body);
  });
}

function postNative(target, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "Content-Length": body.length },
        timeout: 15000,
      },
      (upstream) => {
        const parts = [];
        upstream.on("data", (chunk) => parts.push(chunk));
        upstream.on("end", () =>
          resolve({ status: upstream.statusCode || 502, type: upstream.headers["content-type"], body: Buffer.concat(parts).toString("utf8") }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("路由器 15 秒没有响应")));
    req.on("error", reject);
    req.end(body);
  });
}

function postToRouter(target, body) {
  return postWithCurl(target, body).catch(() => postNative(target, body));
}

function serveStatic(req, res) {
  const rawPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const relative = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
  const file = path.resolve(ROOT, relative);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      send(res, 404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });
}

http
  .createServer((req, res) => {
    const pathname = (req.url || "/").split("?")[0];
    if (pathname === "/healthz") {
      send(res, 200, JSON.stringify({ ok: true, router: DEFAULT_ROUTER, uptime: process.uptime() }), {
        "Content-Type": "application/json",
      });
      return;
    }
    if (pathname === "/ubus") {
      if (req.method !== "POST") {
        send(res, 405, "Method Not Allowed");
        return;
      }
      void proxyUbus(req, res);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "Method Not Allowed");
      return;
    }
    serveStatic(req, res);
  })
  .listen(PORT, HOST, () => {
    const nets = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === "IPv4" && !n.internal);
    console.log("CPE Pilot 已启动");
    console.log("  本机:   http://127.0.0.1:" + PORT);
    for (const net of nets) console.log("  局域网: http://" + net.address + ":" + PORT);
    console.log("  默认路由器: http://" + DEFAULT_ROUTER);
  });

