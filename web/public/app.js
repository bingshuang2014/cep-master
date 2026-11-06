/* CPE Pilot — 手机优先的 OpenWrt CPE 控制台
 * 数据通道：ubus JSON-RPC（经同源代理） + root 会话下的 /bin/sh（file.exec）
 */
const APP_VERSION = "1.6";
const THEMES = ["dark", "light", "argon"];
const THEME_NAME = { dark: "深色", light: "浅色", argon: "紫夜" };
const WALLS = {
  forest: { name: "深林", css: "linear-gradient(155deg,#0d3b2e 0%,#071b15 48%,#030b09 100%)" },
  aurora: {
    name: "极光",
    css: "radial-gradient(700px 460px at 18% 12%, rgba(61,220,151,.55), transparent 62%), radial-gradient(700px 460px at 84% 18%, rgba(124,58,237,.5), transparent 58%), linear-gradient(160deg,#07110f,#050a09)",
  },
  violet: {
    name: "紫夜",
    css: "radial-gradient(720px 500px at 80% 0%, rgba(167,139,250,.55), transparent 60%), linear-gradient(160deg,#150f2b,#07040f)",
  },
  mist: { name: "晨雾", css: "linear-gradient(160deg,#e9f3ef 0%,#d3e3dc 46%,#bdcec8 100%)" },
};
const WALL_ORDER = ["forest", "aurora", "violet", "mist"];
const NULL_SID = "00000000000000000000000000000000";
const LS = {
  get(key, fallback = "") {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

const state = {
  router: LS.get("cpe.router", "192.168.6.1"),
  user: LS.get("cpe.user", "root"),
  pass: LS.get("cpe.pass", "root"),
  remember: LS.get("cpe.remember", "1") === "1",
  sid: null,
  authed: false,
  demo: false,
  page: "home",
  snap: null,
  loading: false,
  error: "",
  busy: false,
  theme: LS.get("cpe.theme", "dark"),
  quality: null,
  wallpaper: (() => {
    try { return JSON.parse(LS.get("cpe.wallpaper", "null")); } catch { return null; }
  })(),
  logText: "",
  diagText: "",
  tools: null,
  toolsLoading: false,
  toolsError: "",
  atOut: "",
  sms: { to: "", body: "", inbox: null, inboxError: "" },
};

const boot = { timer: null, started: 0, lastBytes: null, busy: false };
applyTheme();
applyWallpaper();
const samples = [];

/* ------------------------------ helpers ------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
function applyTheme() {
  try { document.documentElement.dataset.theme = state.theme; } catch { /* ignore */ }
}

function applyWallpaper() {
  const root = document.documentElement;
  if (!root || !root.style) return;
  const w = state.wallpaper;
  if (!w) {
    root.style.removeProperty("--wall-image");
    root.style.setProperty("--wall-blur", "0px");
    root.style.setProperty("--wall-dim", "0");
    return;
  }
  const img = w.kind === "custom" ? 'url("' + w.data + '")' : (WALLS[w.id] || WALLS.forest).css;
  root.style.setProperty("--wall-image", img);
  root.style.setProperty("--wall-blur", (w.blur || 0) + "px");
  root.style.setProperty("--wall-dim", String(w.dim == null ? 0.25 : w.dim));
}

let wallSaveTimer = null;
function saveWallpaper() {
  try {
    if (state.wallpaper) localStorage.setItem("cpe.wallpaper", JSON.stringify(state.wallpaper));
    else localStorage.removeItem("cpe.wallpaper");
    return true;
  } catch (err) {
    toast("图片太大，保存失败，换一张小点的");
    return false;
  }
}

function readWallFile(file) {
  if (!file || !/^image\//.test(file.type)) { toast("请选择图片文件"); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 1600;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      let data = canvas.toDataURL("image/jpeg", 0.82);
      if (data.length > 2800000) data = canvas.toDataURL("image/jpeg", 0.6);
      state.wallpaper = { kind: "custom", data, blur: 4, dim: 0.3 };
      if (!saveWallpaper()) return;
      applyWallpaper();
      render();
      toast("壁纸已应用");
    };
    img.onerror = () => toast("图片读取失败");
    img.src = reader.result;
  };
  reader.onerror = () => toast("图片读取失败");
  reader.readAsDataURL(file);
}
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return "--";
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + " " + units[i];
}

function fmtRate(bps) {
  if (!bps || bps < 1) return "0 KB/s";
  if (bps < 1024) return Math.round(bps) + " B/s";
  return fmtBytes(bps) + "/s";
}

function fmtUptime(sec) {
  if (sec == null) return "--";
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + " 天 " + h + " 小时";
  if (h > 0) return h + " 小时 " + m + " 分";
  if (m > 0) return m + " 分 " + (s % 60) + " 秒";
  return s + " 秒";
}

function pad(n) { return String(n).padStart(2, "0"); }

const CODE_TEXT = {
  2: "参数无效", 3: "方法不存在", 4: "对象不存在", 5: "元素不存在",
  6: "没有权限（会话可能过期）", 7: "会话已超时", 8: "系统错误",
};

class SessionError extends Error {
  constructor(message = "登录状态已过期") { super(message); this.name = "SessionError"; }
}

/* ------------------------------ transport ------------------------------ */
/* 安卓 APK 内置的 WebView 桥：file:// 页面不能直接 fetch 路由器 /ubus，
 * 交给原生 HttpURLConnection 发请求（没有 CORS 限制）。 */
const native = {
  seq: 0,
  pending: new Map(),
  available() {
    return Boolean(window.CpeNative && typeof window.CpeNative.ubus === "function");
  },
  call(router, body) {
    return new Promise((resolve, reject) => {
      const id = String(++this.seq);
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("原生通道超时（20 秒）")); }
      }, 20000);
      this.pending.set(id, (text) => { clearTimeout(timer); resolve(text); });
      try {
        window.CpeNative.ubus(id, router, JSON.stringify(body));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  },
};
window.__cpeNativeResult = (id, text) => {
  const done = native.pending.get(String(id));
  if (!done) return;
  native.pending.delete(String(id));
  done(text);
};

async function gateway(body) {
  if (native.available()) {
    const text = await native.call(state.router, body);
    let json;
    try { json = JSON.parse(text); } catch { throw new Error("路由器返回了非 JSON 内容。"); }
    if (json.error) throw new Error(json.error.message || "网关错误");
    return json.result;
  }
  let res;
  try {
    res = await fetch("/ubus", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CPE-Router": state.router },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (err) {
    throw new Error("连不上本机网关服务。请确认启动面板的终端还开着，手机和路由器在同一网络。");
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error("网关返回了非 JSON 内容（HTTP " + res.status + "）。");
  }
  if (json.error) throw new Error(json.error.message || "网关错误");
  return json.result;
}

let loginTask = null;

async function login() {
  if (loginTask) return loginTask;
  loginTask = doLoginRpc().finally(() => { loginTask = null; });
  return loginTask;
}

async function doLoginRpc() {
  const result = await gateway({
    jsonrpc: "2.0", id: 1, method: "call",
    params: [NULL_SID, "session", "login", { username: state.user, password: state.pass }],
  });
  if (!Array.isArray(result)) throw new Error("登录接口返回格式异常");
  if (result[0] === 6) throw new Error("账号或密码不正确。这台 CPE 用 root / 你的管理密码登录。");
  if (result[0] !== 0) throw new Error(CODE_TEXT[result[0]] || "登录被拒绝（代码 " + result[0] + "）");
  const sid = result[1] && result[1].ubus_rpc_session;
  if (!sid) throw new Error("路由器没有发回会话编号");
  state.sid = sid;
  boot.started = Date.now();
}

async function rawCall(obj, method, args = {}) {
  const result = await gateway({
    jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "call",
    params: [state.sid, obj, method, args],
  });
  if (!Array.isArray(result)) throw new Error("ubus 返回格式异常");
  if (result[0] === 6 || result[0] === 7) throw new SessionError();
  if (result[0] !== 0) throw new Error(obj + "." + method + "：" + (CODE_TEXT[result[0]] || "错误 " + result[0]));
  return result[1] ?? {};
}

async function call(obj, method, args = {}) {
  try {
    return await rawCall(obj, method, args);
  } catch (err) {
    if (err instanceof SessionError && state.pass) {
      await login();
      return await rawCall(obj, method, args);
    }
    throw err;
  }
}

const SHELL_SCRIPT = [
  'echo "@TEMP"',
  'for f in /sys/class/thermal/thermal_zone*/temp /sys/class/hwmon/hwmon*/temp1_input; do [ -s "$f" ] && cat "$f" && break; done 2>/dev/null',
  'echo "@SSID24"',
  'uci -q get wireless.default_radio0.ssid',
  'echo "@CH24"',
  'uci -q get wireless.radio0.channel',
  'echo "@SSID5"',
  'uci -q get wireless.default_radio1.ssid',
  'echo "@CH5"',
  'uci -q get wireless.radio1.channel',
  'echo "@A0"',
  'ubus call iwinfo assoclist \'{"device":"phy0-ap0"}\' 2>/dev/null',
  'echo "@A1"',
  'ubus call iwinfo assoclist \'{"device":"phy1-ap0"}\' 2>/dev/null',
  'echo "@NET"',
  'cat /proc/net/dev',
  'echo "@USB"',
  'cat /sys/bus/usb/devices/1-1/idVendor /sys/bus/usb/devices/1-1/idProduct 2>/dev/null',
  'echo "@TTY"',
  'ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null',
  'echo "@CPU"',
  'ubus call luci getCPUUsage 2>/dev/null',
  'echo "@END"',
].join("\n");

async function shell(command) {
  const result = await call("file", "exec", { command: "/bin/sh", params: ["-c", command] });
  if (result && typeof result === "object" && typeof result.stdout === "string") return result;
  return { code: 0, stdout: "", stderr: "" };
}

/* ------------------------------ parsing ------------------------------ */
function splitSections(stdout) {
  const out = {};
  let key = "_";
  out[key] = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = line.match(/^@([A-Z0-9_]+)$/);
    if (m) { key = m[1]; out[key] = []; continue; }
    (out[key] ||= []).push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join("\n").trim();
  return out;
}

function parseAssoc(text) {
  try {
    const json = JSON.parse(text || "{}");
    const list = Array.isArray(json.results) ? json.results : [];
    return list.map((c) => ({
      mac: String(c.mac || "").toUpperCase(),
      signal: Number(c.signal),
      rate: Number(c.tx && c.tx.rate ? c.tx.rate : 0) / 1000,
      connected: Number(c.connected_time || 0),
    }));
  } catch {
    return [];
  }
}

function parseNetDev(text) {
  const map = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.@-]+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
    if (!m) continue;
    map[m[1]] = { rx: Number(m[2]), tx: Number(m[3]) };
  }
  return map;
}

function parseInterfaceDump(raw) {
  const list = raw && Array.isArray(raw.interface) ? raw.interface : [];
  return list.map((i) => {
    const v4 = (i["ipv4-address"] || [])[0];
    const v6 = (i["ipv6-address"] || [])[0];
    return {
      name: i.interface,
      up: Boolean(i.up),
      proto: i.proto || "",
      device: i.device || i.l3_device || "",
      uptime: Number(i.uptime || 0),
      ipv4: v4 ? v4.address + "/" + v4.mask : "",
      ipv6: v6 ? v6.address : "",
      gateway: i.route && i.route[0] ? i.route[0].nexthop : "",
      dns: Array.isArray(i["dns-server"]) ? i["dns-server"] : [],
      available: i.available !== false,
    };
  });
}

function parseLeases(raw) {
  const list = raw && Array.isArray(raw.dhcp_leases) ? raw.dhcp_leases : [];
  return list.map((l) => ({
    host: l.hostname || "",
    ip: l.ipaddr || "",
    mac: String(l.macaddr || "").toUpperCase(),
    expires: Number(l.expires || 0),
  }));
}

function macKey(mac) { return String(mac || "").toUpperCase(); }

function buildSnapshot(parts) {
  const { board, info, ifdump, leasesRaw, shellText, onlineRaw } = parts;
  const release = (board && board.release) || {};
  const mem = (info && info.memory) || {};
  const load = Array.isArray(info && info.load) ? info.load : [0];
  const sec = splitSections(shellText);
  const tempRaw = Number((sec.TEMP || "").trim());
  const temp = Number.isFinite(tempRaw) && tempRaw > 0 ? (tempRaw > 1000 ? tempRaw / 1000 : tempRaw) : null;
  const netdev = parseNetDev(sec.NET);
  const clients = [
    ...parseAssoc(sec.A0).map((c) => ({ ...c, band: "2.4G" })),
    ...parseAssoc(sec.A1).map((c) => ({ ...c, band: "5G" })),
  ];
  const leases = parseLeases(leasesRaw);
  for (const c of clients) {
    const hit = leases.find((l) => l.mac === c.mac);
    c.ip = hit ? hit.ip : "";
    c.host = hit ? hit.host : "";
  }
  const ifaces = parseInterfaceDump(ifdump);
  const wan = ifaces.find((i) => i.device === "usb0" && i.proto === "dhcp") ||
    ifaces.find((i) => i.name !== "lan" && i.ipv4 && i.up) || null;
  const lan = ifaces.find((i) => i.name === "lan") || null;
  const wanStats = netdev.usb0 || netdev.wwan0 || null;
  const lanStats = netdev["br-lan"] || null;
  const cpuText = (sec.CPU || "").replace(/[^0-9]/g, "");
  const cpu = cpuText ? Number(cpuText) : null;
  const online = onlineRaw && Number.isFinite(Number(onlineRaw.onlineusers)) ? Number(onlineRaw.onlineusers) : null;
  const ttyList = (sec.TTY || "").split(/\s+/).filter(Boolean);

  return {
    model: (board && board.model) || "OpenWrt 设备",
    hostname: (board && board.hostname) || "CPE",
    kernel: (board && board.kernel) || "",
    system: (board && board.system) || "",
    firmware: [release.distribution, release.version].filter(Boolean).join(" ") || "",
    revision: release.revision || "",
    buildDesc: release.description || "",
    uptime: Number((info && info.uptime) || 0),
    load1: Number(load[0] || 0) / 65536,
    memTotal: Number(mem.total || 0),
    memFree: Number(mem.free || 0),
    memUsed: Number(mem.total || 0) - Number(mem.available || mem.free || 0),
    temp,
    cpu,
    online,
    ifaces,
    wan,
    lan,
    wanStats,
    lanStats,
    ssid24: (sec.SSID24 || "").trim() || "",
    ssid5: (sec.SSID5 || "").trim() || "",
    ch24: (sec.CH24 || "").trim(),
    ch5: (sec.CH5 || "").trim(),
    clients,
    leases,
    modem: { vendor: (sec.USB || "").split(/\s+/)[0] || "", product: (sec.USB || "").split(/\s+/)[1] || "" },
    ttyList,
    takenAt: Date.now(),
  };
}

/* ------------------------------ load ------------------------------ */
async function refresh() {
  if (!state.authed || state.demo) return;
  if (boot.busy) return;
  boot.busy = true;
  try {
    if (!state.sid) await login();
    const [board, info, ifdump, leasesRaw, shellRes, onlineRaw] = await Promise.all([
      call("system", "board"),
      call("system", "info"),
      call("network.interface", "dump"),
      call("luci-rpc", "getDHCPLeases").catch(() => null),
      shell(SHELL_SCRIPT).catch(() => ({ stdout: "" })),
      call("luci", "getOnlineUsers").catch(() => null),
    ]);
    const snapshot = buildSnapshot({
      board, info, ifdump, leasesRaw,
      shellText: (shellRes && shellRes.stdout) || "",
      onlineRaw,
    });
    const now = Date.now();
    if (boot.lastBytes && snapshot.wanStats) {
      const dt = Math.max(0.5, (now - boot.lastBytes.t) / 1000);
      snapshot.rxRate = Math.max(0, (snapshot.wanStats.rx - boot.lastBytes.rx) / dt);
      snapshot.txRate = Math.max(0, (snapshot.wanStats.tx - boot.lastBytes.tx) / dt);
    } else {
      snapshot.rxRate = 0;
      snapshot.txRate = 0;
    }
    if (snapshot.wanStats) boot.lastBytes = { rx: snapshot.wanStats.rx, tx: snapshot.wanStats.tx, t: now };
    samples.push({ down: snapshot.rxRate, up: snapshot.txRate });
    if (samples.length > 48) samples.shift();
    state.snap = snapshot;
    state.error = "";
  } catch (err) {
    if (err instanceof SessionError) {
      state.sid = null;
      state.authed = false;
      state.error = "登录已过期，请重新登录";
      render();
      return;
    }
    state.error = err.message || "刷新失败";
  } finally {
    boot.busy = false;
    state.loading = false;
    render();
  }
}

function schedule() {
  clearTimeout(boot.timer);
  boot.timer = setTimeout(async () => {
    if (document.visibilityState === "visible" && (state.page === "home" || state.page === "network")) {
      await refresh();
    }
    schedule();
  }, 5000);
}

/* ------------------------------ actions ------------------------------ */
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("on"), 2600);
}

function openSheet(title, bodyHtml, actions) {
  const sheet = $("#sheet");
  $("#sheet-title").textContent = title;
  $("#sheet-body").innerHTML = bodyHtml;
  const box = $("#sheet-actions");
  box.innerHTML = "";
  for (const action of actions) {
    const btn = document.createElement("button");
    btn.className = "btn " + (action.kind || "ghost");
    btn.textContent = action.label;
    btn.onclick = async () => {
      closeSheet();
      if (action.run) await action.run();
    };
    box.appendChild(btn);
  }
  sheet.hidden = false;
}

function closeSheet() { $("#sheet").hidden = true; }

async function doLogin() {
  state.router = ($("#router") && $("#router").value.trim()) || state.router;
  state.user = ($("#user") && $("#user").value.trim()) || "root";
  state.pass = ($("#pass") && $("#pass").value) || "";
  state.remember = Boolean($("#remember") && $("#remember").checked);
  if (!state.router) { state.error = "请填写路由器地址"; render(); return; }
  if (!state.user) { state.error = "请填写用户名"; render(); return; }
  if (!state.pass) { state.error = "请填写管理密码"; render(); return; }
  state.busy = true;
  state.error = "";
  render();
  try {
    await login();
    state.authed = true;
    state.demo = false;
    LS.set("cpe.router", state.router);
    LS.set("cpe.user", state.user);
    LS.set("cpe.remember", state.remember ? "1" : "0");
    if (state.remember) LS.set("cpe.pass", state.pass);
    else LS.del("cpe.pass");
    state.loading = true;
    render();
    await refresh();
    state.busy = false;
    if (!state.snap) {
      state.authed = false;
      state.sid = null;
      state.error = state.error || "登录成功，但读不到状态数据";
      state.loading = false;
      render();
      return;
    }
    toast("已连接 " + state.router);
  } catch (err) {
    state.authed = false;
    state.sid = null;
    state.error = err.message || "登录失败";
    state.busy = false;
    state.loading = false;
    render();
  }
}

function logout(message = "") {
  state.authed = false;
  state.sid = null;
  state.snap = null;
  state.page = "home";
  state.error = message;
  state.loading = false;
  state.busy = false;
  boot.lastBytes = null;
  samples.length = 0;
  render();
}

function enterDemo() {
  state.demo = true;
  state.authed = true;
  state.error = "";
  state.page = "home";
  state.snap = demoSnapshot();
  state.quality = { avg: 23.4, jitter: 1.2, min: 21, max: 26, at: Date.now() };
  render();
}

function demoSnapshot() {
  return {
    model: "5G-CPE (演示)", hostname: "Smart-CPE", kernel: "6.6.102", system: "MediaTek MT7621",
    firmware: "24.10-SNAPSHOT", revision: "09.01.2025", buildDesc: "5G-CPE 24.10-SNAPSHOT",
    uptime: 187633, load1: 0.12, memTotal: 254238720, memFree: 135266304, memUsed: 118972416,
    temp: 46.5, cpu: 7, online: 3,
    wan: { name: "USB", up: true, proto: "dhcp", device: "usb0", uptime: 5349, ipv4: "192.168.66.2/24", ipv6: "", gateway: "192.168.66.1", dns: ["192.168.66.1"] },
    lan: { name: "lan", up: true, proto: "static", device: "br-lan", ipv4: "192.168.6.1/24", ipv6: "", gateway: "", dns: [], uptime: 5388 },
    wanStats: { rx: 1798472429, tx: 136810005 }, lanStats: { rx: 10865192, tx: 13329991 },
    rxRate: 8421376, txRate: 412672,
    ssid24: "Smart-CPE_2.4G", ssid5: "Smart-CPE_5G", ch24: "1", ch5: "36",
    clients: [
      { mac: "82:10:7E:D8:E9:43", ip: "192.168.6.249", host: "Redmi-K60-Pro", signal: -64, rate: 104, band: "2.4G", connected: 2483 },
      { mac: "2E:FF:22:DF:3C:18", ip: "192.168.6.128", host: "Redmi-K70E", signal: -52, rate: 130, band: "2.4G", connected: 1488 },
      { mac: "A6:1E:B1:86:C4:F2", ip: "192.168.6.221", host: "", signal: -71, rate: 96, band: "5G", connected: 2488 },
    ],
    leases: [],
    modem: { vendor: "1782", product: "4038" },
    ttyList: [],
    ifaces: [],
    takenAt: Date.now(),
  };
}

/* ------------------------------ view: login ------------------------------ */
function viewLogin() {
  const savedPass = state.pass;
  return `
  <div class="login">
    <div class="brand">
      <div class="brand-mark">${MARK}</div>
      <div>
        <h1>手搓CPE</h1>
        <p>OpenWrt · 5G CPE 控制台</p>
      </div>
    </div>
    ${state.error ? '<div class="error-box">' + esc(state.error) + "</div>" : ""}
    <form id="login-form" autocomplete="on">
      <div class="field">
        <label for="router">路由器地址</label>
        <input class="input" id="router" name="router" value="${esc(state.router)}" placeholder="192.168.6.1" inputmode="url" autocapitalize="off" spellcheck="false" />
      </div>
      <div class="row-2">
        <div class="field">
          <label for="user">用户名</label>
          <input class="input" id="user" name="user" value="${esc(state.user)}" placeholder="root" autocapitalize="off" spellcheck="false" />
        </div>
        <div class="field">
          <label for="pass">密码</label>
          <input class="input" id="pass" name="pass" type="password" value="${esc(savedPass)}" placeholder="管理密码" autocomplete="current-password" />
        </div>
      </div>
      <label class="check">
        <input type="checkbox" id="remember" ${state.remember ? "checked" : ""} />
        在这台设备上记住密码
      </label>
      <button class="btn" type="submit" ${state.busy ? "disabled" : ""}>${state.busy ? "正在连接…" : "登录 CPE"}</button>
    </form>
    <div class="hint-box">
      路由器默认在 <b>192.168.6.1</b>，账号 <b>root</b>。
      ${native.available() ? "APK 内置原生 ubus 通道，直接连路由器，无需电脑或额外服务。" : "面板通过本机小网关代访 /ubus，绕开 OpenWrt 的跨域限制。"}
    </div>
    <div class="login-foot">
      <button class="demo-link" data-action="demo">先看看演示界面 →</button>
      <div style="margin-top:8px">v${APP_VERSION}</div>
    </div>
  </div>`;
}

/* ------------------------------ view: shell ------------------------------ */
const MARK = '<svg viewBox="0 0 64 64" fill="none"><path d="M14 41a18 18 0 0 1 36 0" stroke="url(#g2)" stroke-width="5" stroke-linecap="round"/><path d="M23 45a9 9 0 0 1 18 0" stroke="#7ce8c5" stroke-width="4" stroke-linecap="round" opacity=".75"/><circle cx="32" cy="51" r="3.6" fill="#3ddc97"/><defs><linearGradient id="g2" x1="14" y1="41" x2="50" y2="41"><stop stop-color="#3ddc97"/><stop offset="1" stop-color="#2bb5a0"/></linearGradient></defs></svg>';

function signalClass(sig) {
  if (!Number.isFinite(sig)) return "s0";
  if (sig >= -55) return "s4";
  if (sig >= -65) return "s3";
  if (sig >= -75) return "s2";
  if (sig >= -85) return "s1";
  return "s0";
}

function sigBars(sig) {
  return '<span class="sig ' + signalClass(sig) + '"><i></i><i></i><i></i><i></i></span>';
}

function viewApp() {
  const snap = state.snap;
  if (!snap) {
    return shellFrame(`
      <div class="page">
        <div class="skeleton sk-hero"></div>
        <div class="metrics">${'<div class="skeleton sk-metric"></div>'.repeat(4)}</div>
        <div class="skeleton sk-line"></div>
      </div>`);
  }
  const pages = { home: viewHome, network: viewNetwork, tools: viewTools, sms: viewSms, more: viewMore, smart: viewSmart };
  const content = (pages[state.page] || viewHome)(snap);
  return shellFrame(content, snap);
}

function shellFrame(content, snap) {
  const model = snap ? snap.model : "手搓CPE";
  const host = state.demo ? "演示模式" : state.router;
  return `
  <header class="topbar">
    <div class="mark">${MARK}</div>
    <div class="who">
      <strong>${esc(model)}</strong>
      <span>${state.demo ? "演示模式 · 数据为示例" : esc(host) + (snap ? " · " + esc(snap.hostname) : "")}</span>
    </div>
    <span class="live-dot">${state.demo ? "DEMO" : "LIVE"}</span>
    <button class="icon-btn" data-action="theme" aria-label="切换主题">${ICON_THEME}</button>
    <button class="icon-btn ${state.loading ? "spin" : ""}" data-action="refresh" aria-label="刷新">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
    </button>
  </header>
  <main>${state.error ? '<div class="error-box" style="margin-bottom:12px">' + esc(state.error) + "</div>" : ""}${content}</main>
  <nav class="nav">
    ${navBtn("home", "概览", ICON_HOME)}
    ${navBtn("network", "网络", ICON_NET)}
    ${navBtn("tools", "工具", ICON_TOOLS)}
    ${navBtn("sms", "短信", ICON_SMS)}
    ${navBtn("more", "更多", ICON_MORE)}
  </nav>`;
}

function navBtn(page, label, icon) {
  return `<button data-page="${page}" class="${state.page === page ? "on" : ""}">${icon}<span>${label}</span></button>`;
}

/* ------------------------------ view: home ------------------------------ */
function viewHome(s) {
  const memPct = s.memTotal ? Math.min(100, (s.memUsed / s.memTotal) * 100) : 0;
  const loadPct = Math.min(100, (s.load1 / 2) * 100);
  const tempPct = s.temp == null ? null : Math.min(100, (s.temp / 100) * 100);
  const wanUp = s.wan && s.wan.up;
  const clients = s.clients || [];
  return `
  <div class="page">
    <section class="card hero">
      <div class="hero-top">
        <div>
          <h2>${esc(s.model)}</h2>
          <div class="sub">${esc(s.firmware || "OpenWrt")} · 内核 ${esc(s.kernel || "--")}</div>
        </div>
        <span class="pill ${wanUp ? "" : "bad"}">${wanUp ? "WAN 在线" : "WAN 断开"}</span>
      </div>
      <div class="chip-row">
        <span class="chip ${wanUp ? "" : "bad"}"><i class="dot"></i>WAN ${wanUp ? "在线" : "断开"}</span>
        <span class="chip">${clients.length} 台终端</span>
        <span class="chip">${s.modem && s.modem.vendor ? "USB 5G" : "OpenWrt"}</span>
        <span class="chip">运行 ${fmtUptime(s.uptime)}</span>
      </div>
      <div class="speed-wrap">
        <div class="speed-now"><b>${fmtRate(s.rxRate)}</b><span>下载</span></div>
        <div class="speed-sub">
          <span>↑ ${fmtRate(s.txRate)}</span>
          <span>累计 ↓ ${fmtBytes(s.wanStats ? s.wanStats.rx : 0)}</span>
          <span>↑ ${fmtBytes(s.wanStats ? s.wanStats.tx : 0)}</span>
        </div>
        <canvas class="spark" id="spark" height="136"></canvas>
      </div>
    </section>

    <div class="metrics">
      ${metric("内存", fmtBytes(s.memUsed), "/ " + fmtBytes(s.memTotal), memPct, "已用 " + memPct.toFixed(0) + "%", "var(--mint)")}
      ${metric("系统负载", s.load1.toFixed(2), "", loadPct, "1 分钟平均", "var(--blue)")}
      ${metric("温度", s.temp == null ? "--" : s.temp.toFixed(1), "°C", tempPct, s.temp == null ? "未找到温度传感器" : "SoC 温度", "var(--amber)")}
      ${metric("在线终端", String(s.online ?? clients.length), "台", Math.min(100, (clients.length / 16) * 100), clients.length + " 台 Wi-Fi 关联", "var(--mint-2)")}
    </div>

    <div class="quick">
      ${quickTile("refresh", ICON_REFRESH, "刷新")}
      ${quickTile("wifi-reload", ICON_WIFI, "重启 Wi-Fi")}
      ${quickTile("smart", ICON_LINK, "通信壳")}
      ${quickTile("ping-quality", ICON_PULSE, "测延迟")}
    </div>

    ${qualityCard()}

    ${smartCard()}

    <section class="card">
      <div class="card-head">
        <div class="card-title">${ICON_NET} 上行链路</div>
        <span class="badge ${wanUp ? "" : "off"}">${wanUp ? "已连接" : "未连接"}</span>
      </div>
      ${kv("接口", s.wan ? s.wan.name + " · " + s.wan.device : "未发现 WAN")}
      ${kv("IPv4", s.wan && s.wan.ipv4 ? s.wan.ipv4 : "--", true)}
      ${kv("网关", s.wan && s.wan.gateway ? s.wan.gateway : "--", true)}
      ${kv("DNS", s.wan && s.wan.dns && s.wan.dns.length ? s.wan.dns.join(" · ") : "--", true)}
      ${kv("在线时长", fmtUptime(s.wan ? s.wan.uptime : s.uptime))}
    </section>

    <section class="card">
      <div class="card-head">
        <div class="card-title">${ICON_WIFI} 无线网络</div>
        <span class="badge">${clients.length} 台终端</span>
      </div>
      <div class="kv"><span class="k">2.4G</span><span class="v">${esc(s.ssid24 || "未启用")} <span class="note">${esc(s.ch24 || "")} 信道</span></span></div>
      <div class="kv"><span class="k">5G</span><span class="v">${esc(s.ssid5 || "未启用")} <span class="note">${esc(s.ch5 || "")} 信道</span></span></div>
      ${clients.length ? clients.slice(0, 4).map(clientRow).join("") : '<div class="empty">暂时没有无线终端连接</div>'}
    </section>

    <div class="btn-row">
      <button class="btn ghost small" data-action="luci">打开 LuCI</button>
      <button class="btn quiet small" data-action="reboot">重启路由器</button>
    </div>
  </div>`;
}

function quickTile(action, icon, label) {
  return `<button class="quick-tile" data-action="${action}">${icon}<span>${label}</span></button>`;
}

function qualityCard() {
  const q = state.quality;
  const label = q && q.loading ? "测速中…" : q ? "重测" : "测一下";
  return `<section class="card">
    <div class="quality-head">
      <div class="card-title">${ICON_PULSE} 网络质量</div>
      <button class="card-action" data-action="ping-quality">${label}</button>
    </div>
    ${qualityBody(q)}
  </section>`;
}

function qualityBody(q) {
  if (!q) return '<div class="empty">测试路由器到公网的延迟与抖动</div>';
  if (q.loading) return '<div class="empty">正在 ping 223.5.5.5…</div>';
  if (q.error) return '<div class="error-box" style="margin:0">' + esc(q.error) + "</div>";
  const cls = q.avg < 60 ? "good" : q.avg < 100 ? "mid" : "bad";
  const text = q.avg < 60 ? "优秀" : q.avg < 100 ? "良好" : q.avg < 180 ? "一般" : "较差";
  return `<div class="q-body">
    <div>
      <div class="q-big">${Math.round(q.avg)}<small>ms</small></div>
      <div class="q-row"><span>抖动 ${Number(q.jitter || 0).toFixed(1)} ms</span><span>${text}</span></div>
    </div>
    <div class="q-bars ${cls}"><i></i><i></i><i></i><i></i></div>
  </div>`;
}

function metric(label, value, unit, pct, foot, color) {
  const circ = 2 * Math.PI * 20;
  const safe = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const dash = (safe / 100) * circ;
  return `<div class="metric ring-card">
    <span class="ring">
      <svg viewBox="0 0 48 48">
        <circle class="ring-bg" cx="24" cy="24" r="20"></circle>
        <circle class="ring-fg" cx="24" cy="24" r="20" style="--ring-color:${color || "var(--mint)"};stroke-dasharray:${dash.toFixed(1)} ${circ.toFixed(1)}"></circle>
      </svg>
      <span>${pct == null ? "--" : Math.round(safe) + "%"}</span>
    </span>
    <div class="metric-info">
      <div class="label">${label}</div>
      <div class="value">${value}<small>${unit}</small></div>
      <div class="foot">${esc(foot)}</div>
    </div>
  </div>`;
}

function kv(k, v, mono) {
  return `<div class="kv"><span class="k">${esc(k)}</span><span class="v ${mono ? "mono" : ""}">${esc(v)}</span></div>`;
}

function clientRow(c) {
  const name = c.host || c.ip || c.mac;
  const sub = [c.ip && c.host ? c.ip : c.mac, c.band, c.rate ? c.rate.toFixed(0) + " Mbps" : ""].filter(Boolean).join(" · ");
  return `<div class="client">
    <div class="avatar">${ICON_PHONE}</div>
    <div class="info"><strong>${esc(name)}</strong><span>${esc(sub)}</span></div>
    <div class="sig-num">${Number.isFinite(c.signal) ? c.signal + " dBm" : ""}</div>
    ${sigBars(c.signal)}
  </div>`;
}

/* ------------------------------ view: network ------------------------------ */
function viewNetwork(s) {
  const ifaces = (s.ifaces || []).filter((i) => i.name !== "loopback");
  return `
  <div class="page">
    <div class="section-title">接口</div>
    ${ifaces.length ? ifaces.map((i) => `
      <div class="iface">
        <div class="iface-top">
          <div class="iface-name"><span class="dot ${i.up ? "" : "down"}"></span>${esc(i.name)}</div>
          <span class="badge ${i.up ? "" : "off"}">${i.up ? "UP" : "DOWN"}</span>
        </div>
        <div class="iface-sub">${esc(i.proto || "--")} · ${esc(i.device || "--")}${i.uptime ? " · " + fmtUptime(i.uptime) : ""}</div>
        <div class="iface-stats">
          <span>${esc(i.ipv4 || i.ipv6 || "无地址")}</span>
          ${i.gateway ? "<span>网关 " + esc(i.gateway) + "</span>" : ""}
        </div>
      </div>`).join("") : '<div class="empty">没有读到接口信息</div>'}

    <div class="section-title">无线终端</div>
    <section class="card">
      ${s.clients.length ? s.clients.map((c) => clientRow(c)).join("") : '<div class="empty">暂无 Wi-Fi 终端关联</div>'}
    </section>

    <div class="section-title">DHCP 租约</div>
    <section class="card">
      ${s.leases.length ? s.leases.map((l) => `
        <div class="client">
          <div class="avatar">${ICON_DEVICE}</div>
          <div class="info"><strong>${esc(l.host || "未命名设备")}</strong><span>${esc(l.ip)} · ${esc(l.mac)}</span></div>
          <div class="sig-num">${l.expires ? Math.max(0, Math.round((l.expires - Date.now() / 1000) / 3600)) + "h" : ""}</div>
        </div>`).join("") : '<div class="empty">没有 DHCP 租约</div>'}
    </section>

    <div class="section-title">5G 模组</div>
    <section class="card">
      ${kv("USB ID", (s.modem.vendor || "--") + ":" + (s.modem.product || "--"), true)}
      ${kv("AT 串口", s.ttyList.length ? s.ttyList.join("、") : "未暴露（仅 RNDIS 网卡）")}
      ${kv("拨号接口", s.wan ? s.wan.device + " · " + s.wan.proto : "--", true)}
      <div class="note">模组以 RNDIS 方式提供 usb0 上网。没有 AT 串口时，网页端读不到 RSRP/SINR 等无线指标，也无法收发短信；需要固件加载 usb-serial 驱动后才会出现 /dev/ttyUSB*。</div>
    </section>

    <div class="section-title">流量</div>
    <section class="card">
      ${kv("WAN 累计下行", fmtBytes(s.wanStats ? s.wanStats.rx : 0))}
      ${kv("WAN 累计上行", fmtBytes(s.wanStats ? s.wanStats.tx : 0))}
      ${kv("LAN 累计下行", fmtBytes(s.lanStats ? s.lanStats.rx : 0))}
      ${kv("LAN 累计上行", fmtBytes(s.lanStats ? s.lanStats.tx : 0))}
    </section>
    <div class="note">接口数据来自 network.interface dump 与 /proc/net/dev；Wi-Fi 信号来自 iwinfo assoclist。</div>
  </div>`;
}


/* ------------------------------ view: tools ------------------------------ */
const TOOLS_SCRIPT = [
  'echo "@FAN"', "uci -q get 'luci-fan.@luci-fan[0].enabled'",
  'echo "@TR_E"', "uci -q get 'timedreboot.@main[0].enable'",
  'echo "@TR_H"', "uci -q get 'timedreboot.@main[0].hour'",
  'echo "@TR_M"', "uci -q get 'timedreboot.@main[0].minute'",
  'echo "@TR_W"', "uci -q get 'timedreboot.@main[0].week'",
  'echo "@WC_EN"', '/etc/init.d/watchcat enabled >/dev/null 2>&1 && echo 1 || echo 0',
  'echo "@WC_P"', "uci -q get 'watchcat.@watchcat[0].period'",
  'echo "@WC_H"', "uci -q get 'watchcat.@watchcat[0].pinghosts'",
  'echo "@TB_SW"', "uci -q get 'turboacc.config.sw_flow'",
  'echo "@TB_HW"', "uci -q get 'turboacc.config.hw_flow'",
  'echo "@TB_SFE"', "uci -q get 'turboacc.config.sfe_flow'",
  'echo "@TB_FC"', "uci -q get 'turboacc.config.fullcone_nat'",
  'echo "@TB_BBR"', "uci -q get 'turboacc.config.bbr_cca'",
  'echo "@UP_E"', "uci -q get 'upnpd.config.enabled'",
  'echo "@UP_U"', "uci -q get 'upnpd.config.enable_upnp'",
  'echo "@UP_N"', "uci -q get 'upnpd.config.enable_natpmp'",
  'echo "@EQ_E"', "uci -q get 'eqosplus.@eqosplus[0].enabled'",
  'echo "@EQ_D"', "uci -q get 'eqosplus.@eqosplus[0].download'",
  'echo "@EQ_U"', "uci -q get 'eqosplus.@eqosplus[0].upload'",
  'echo "@PC"', "uci -q get 'parentcontrol.@basic[0].enabled'",
  'echo "@TC"', "uci -q get 'timecontrol.@timecontrol[0].enabled'",
  'echo "@W24"', "uci -q get 'wireless.radio0.channel'",
  'echo "@W5"', "uci -q get 'wireless.radio1.channel'",
  'echo "@CRON"', 'cat /etc/crontabs/root 2>/dev/null',
  'echo "@MODEM"', 'ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null',
].join("\n");

async function loadTools() {
  if (state.demo) {
    state.tools = {
      fan: false,
      tr: { enable: false, hour: "6", minute: "10", week: "6" },
      watchcat: { enabled: false, period: "6h", hosts: "223.5.5.5" },
      turbo: { sw: true, hw: true, sfe: true, fullcone: true, bbr: false },
      upnp: { enabled: true, upnp: true, natpmp: true },
      eqos: { enabled: false, download: "1000", upload: "30" },
      parent: false, timecontrol: false,
      wifi: { ch24: "1", ch5: "36" },
      cron: "# 演示模式\n3 3 12 12 * /usr/bin/nginx-util check_ssl\n",
      modem: [],
    };
    state.toolsLoading = false;
    render();
    return;
  }
  if (state.toolsLoading) return;
  state.toolsLoading = true;
  state.toolsError = "";
  render();
  try {
    const res = await shell(TOOLS_SCRIPT);
    const sec = splitSections(res.stdout || "");
    const g = (k) => (sec[k] || "").trim();
    const on = (k) => g(k) === "1";
    state.tools = {
      fan: on("FAN"),
      tr: { enable: on("TR_E"), hour: g("TR_H") || "6", minute: g("TR_M") || "10", week: g("TR_W") || "6" },
      watchcat: { enabled: on("WC_EN"), period: g("WC_P") || "6h", hosts: g("WC_H") || "223.5.5.5" },
      turbo: { sw: on("TB_SW"), hw: on("TB_HW"), sfe: on("TB_SFE"), fullcone: on("TB_FC"), bbr: on("TB_BBR") },
      upnp: { enabled: on("UP_E"), upnp: on("UP_U"), natpmp: on("UP_N") },
      eqos: { enabled: on("EQ_E"), download: g("EQ_D") || "1000", upload: g("EQ_U") || "30" },
      parent: on("PC"), timecontrol: on("TC"),
      wifi: { ch24: g("W24") || "auto", ch5: g("W5") || "auto" },
      cron: g("CRON"),
      modem: (g("MODEM") || "").split(/\s+/).filter(Boolean),
    };
  } catch (err) {
    state.toolsError = err.message || "读取固件配置失败";
  }
  state.toolsLoading = false;
  render();
}

async function applyTools(command, message) {
  toast("正在应用…");
  try {
    await shell(command);
    toast(message);
    state.tools = null;
    await loadTools();
  } catch (err) {
    toast(err.message || "操作失败");
  }
}

function switchRow(id, label, sub, checked) {
  return `<div class="switch-row">
    <div><div class="sw-label">${esc(label)}</div>${sub ? '<div class="sw-sub">' + esc(sub) + "</div>" : ""}</div>
    <input class="switch" type="checkbox" id="${id}" ${checked ? "checked" : ""} />
  </div>`;
}

function options(values, current) {
  const list = values.includes(current) ? values : [current, ...values];
  return list.map((v) => `<option value="${esc(v)}" ${v === current ? "selected" : ""}>${esc(v === "auto" ? "自动" : v)}</option>`).join("");
}

function viewTools() {
  const t = state.tools;
  if (!t) {
    if (state.toolsLoading) {
      return `<div class="page"><div class="card empty-big"><div class="ico">${SPIN}</div><div>正在读取固件工具配置…</div></div></div>`;
    }
    return `<div class="page"><div class="card empty-big">
      <div class="ico">${ICON_TOOLS}</div>
      <div>读取配置失败</div>
      <div class="note">${esc(state.toolsError || "点下面重试")}</div>
      <button class="btn ghost small" data-action="tool-reload" style="margin-top:14px">重新读取</button>
    </div></div>`;
  }
  const tty = t.modem || [];
  return `
  <div class="page">
    <div class="section-title">锁频 / 信道</div>
    <section class="card">
      <div class="card-head">
        <div class="card-title">${ICON_WIFI} 移动网络锁频</div>
        <span class="badge ${tty.length ? "" : "off"}">${tty.length ? "AT 可用" : "无 AT 通道"}</span>
      </div>
      ${tty.length
        ? `<div class="note">检测到串口：${esc(tty.join("、"))}。可发送 AT 命令（如 AT+QNWPREFCFG="mode_pref",LTE 锁定 4G）。</div>
           <div class="tool-row"><input class="mini-input" id="at-cmd" placeholder="AT+QNWPREFCFG=&quot;mode_pref&quot;,LTE" /></div>
           <button class="btn ghost small" data-action="at-send">发送 AT 命令</button>
           ${state.atOut ? '<div class="logbox" style="margin-top:10px">' + esc(state.atOut) + "</div>" : ""}`
        : `<div class="tool-note">
             当前 5G 模组（USB 1782:4038）以 <b>RNDIS</b> 方式提供 usb0，没有 /dev/ttyUSB* AT 串口，
             这台固件也没给模组加载 usb-serial 驱动，所以下发不了锁频段 / 锁小区 / 锁制式命令。
             这是模组固件模式限制，不是面板功能缺失。
           </div>`}
      <button class="btn quiet small" data-action="tool-reload" style="margin-top:10px">重新检测</button>
    </section>

    <section class="card">
      <div class="card-head"><div class="card-title">${ICON_WIFI} Wi-Fi 信道锁定</div></div>
      <div class="tool-row"><label>2.4G</label><select class="mini-select" id="ch24">${options(["auto", "1", "6", "11"], t.wifi.ch24)}</select></div>
      <div class="tool-row"><label>5G</label><select class="mini-select" id="ch5">${options(["auto", "36", "40", "44", "48", "149", "153", "157", "161"], t.wifi.ch5)}</select></div>
      <button class="btn ghost small" data-action="tool-wifi">应用信道</button>
      <div class="tool-note">切信道会重启无线，终端会短暂掉线约 10 秒。</div>
    </section>

    <div class="section-title">定时与守护</div>
    <section class="card">
      <div class="card-head"><div class="card-title">${ICON_MORE} 定时重启</div><span class="badge ${t.tr.enable ? "" : "off"}">${t.tr.enable ? "已开启" : "已关闭"}</span></div>
      ${switchRow("tr-enable", "启用定时重启", "到点自动重启路由器", t.tr.enable)}
      <div class="tool-row"><label>星期</label><select class="mini-select" id="tr-week">${["周日","周一","周二","周三","周四","周五","周六"].map((n, i) => `<option value="${i}" ${String(i) === String(t.tr.week) ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      <div class="tool-row"><label>时间</label><input class="mini-input" id="tr-hour" type="number" min="0" max="23" value="${esc(t.tr.hour)}" /><span class="tool-note" style="margin:0">时</span><input class="mini-input" id="tr-minute" type="number" min="0" max="59" value="${esc(t.tr.minute)}" /><span class="tool-note" style="margin:0">分</span></div>
      <button class="btn ghost small" data-action="tool-tr">保存定时重启</button>
    </section>

    <section class="card">
      <div class="card-head"><div class="card-title">${ICON_SMS} 断网看门狗</div><span class="badge ${t.watchcat.enabled ? "" : "off"}">${t.watchcat.enabled ? "运行中" : "停用"}</span></div>
      ${switchRow("wc-enable", "启用 watchcat", "断网检测并按策略重启", t.watchcat.enabled)}
      <div class="tool-row"><label>检测周期</label><select class="mini-select" id="wc-period">${options(["30m", "1h", "3h", "6h", "12h", "24h"], t.watchcat.period)}</select></div>
      <div class="tool-row"><label>Ping 目标</label><input class="mini-input" id="wc-hosts" value="${esc(t.watchcat.hosts)}" placeholder="223.5.5.5" /></div>
      <button class="btn ghost small" data-action="tool-wc">保存看门狗</button>
    </section>

    <div class="section-title">性能与网络</div>
    <section class="card">
      <div class="card-head"><div class="card-title">风扇控制</div><span class="badge ${t.fan ? "" : "off"}">${t.fan ? "开启" : "关闭"}</span></div>
      ${switchRow("fan", "启用风扇控制", "按温度自动调速（若硬件带风扇）", t.fan)}
      <button class="btn ghost small" data-action="tool-fan">保存风扇设置</button>
    </section>

    <section class="card">
      <div class="card-head"><div class="card-title">TurboACC 加速</div></div>
      ${switchRow("tb-sw", "软件流量分载", "flow offload", t.turbo.sw)}
      ${switchRow("tb-hw", "硬件流量分载", "HNAT / hw offload", t.turbo.hw)}
      ${switchRow("tb-sfe", "SFE 快速转发", "Shortcut-FE", t.turbo.sfe)}
      ${switchRow("tb-fc", "FullCone NAT", "全锥形 NAT，改善 P2P/游戏", t.turbo.fullcone)}
      ${switchRow("tb-bbr", "BBR 拥塞控制", "TCP BBR", t.turbo.bbr)}
      <button class="btn ghost small" data-action="tool-turbo">保存并重启加速</button>
    </section>

    <section class="card">
      <div class="card-head"><div class="card-title">UPnP / NAT-PMP</div><span class="badge ${t.upnp.enabled ? "" : "off"}">${t.upnp.enabled ? "开启" : "关闭"}</span></div>
      ${switchRow("up-enable", "启用 UPnP 服务", "端口 5000", t.upnp.enabled)}
      ${switchRow("up-upnp", "允许 UPnP", "自动端口映射", t.upnp.upnp)}
      ${switchRow("up-natpmp", "允许 NAT-PMP", "P2P 穿透", t.upnp.natpmp)}
      <button class="btn ghost small" data-action="tool-upnp">保存 UPnP</button>
    </section>

    <section class="card">
      <div class="card-head"><div class="card-title">全局限速 (EQoS)</div><span class="badge ${t.eqos.enabled ? "" : "off"}">${t.eqos.enabled ? "开启" : "关闭"}</span></div>
      ${switchRow("eq-enable", "启用限速", "对 WAN 总带宽限速", t.eqos.enabled)}
      <div class="tool-row"><label>下行</label><input class="mini-input" id="eq-down" type="number" min="1" max="10000" value="${esc(t.eqos.download)}" /><span class="tool-note" style="margin:0">Mbps</span></div>
      <div class="tool-row"><label>上行</label><input class="mini-input" id="eq-up" type="number" min="1" max="10000" value="${esc(t.eqos.upload)}" /><span class="tool-note" style="margin:0">Mbps</span></div>
      <button class="btn ghost small" data-action="tool-eqos">保存限速</button>
    </section>

    <section class="card">
      <div class="card-head"><div class="card-title">家长控制 / 时间控制</div></div>
      ${switchRow("pc-en", "启用家长控制", "网址/协议/时段过滤", t.parent)}
      ${switchRow("tc-en", "启用时间控制", "按时段放行设备", t.timecontrol)}
      <button class="btn ghost small" data-action="tool-parent">保存开关</button>
      <div class="tool-note">详细规则（哪些网址、哪些设备）请到 LuCI 对应应用里配置。</div>
    </section>

    <div class="section-title">计划任务</div>
    <section class="card">
      <div class="card-head"><div class="card-title">crontab</div><button class="card-action" data-action="tool-cron-save">保存</button></div>
      <textarea class="mini-input" id="cron-text" style="width:100%;height:150px;padding:10px;font-family:ui-monospace,monospace;font-size:11px;line-height:1.6;resize:vertical">${esc(t.cron)}</textarea>
      <div class="tool-note">直接编辑 /etc/crontabs/root，保存后自动重启 cron。</div>
    </section>
  </div>`;
}

/* ------------------------------ view: 5G smartcase ------------------------------ */
function smartCard() {
  return `<section class="card">
    <div class="card-head">
      <div class="card-title">${ICON_LINK} 5G 通信壳</div>
      <span class="badge">AT / 锁频 / 基站</span>
    </div>
    <div class="note">AT 命令、锁频段、锁基站、短信转发、温度、网络状态（192.168.66.1:9527）。</div>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn ghost small" data-page="smart">打开通信壳</button>
      <button class="btn quiet small" data-action="smart-external">浏览器打开</button>
    </div>
  </section>`;
}

function viewSmart() {
  const url = "http://192.168.66.1:9527/";
  if (state.demo) {
    return `<div class="page"><div class="card empty-big">
      <div class="ico">${ICON_LINK}</div>
      <div>演示模式不连接 5G 通信壳</div>
    </div></div>`;
  }
  return `<div class="page smart-page">
    <div class="smart-head">
      <div>
        <div class="card-title">${ICON_LINK} 5G 通信壳</div>
        <div class="note">${url} · AT / 锁频段 / 锁基站 / 短信</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="icon-btn" data-action="smart-reload" aria-label="刷新">${ICON_REFRESH}</button>
        <button class="icon-btn" data-action="smart-external" aria-label="外部打开">${ICON_LINK}</button>
      </div>
    </div>
    ${native.available() ? "" : '<div class="note" style="margin:0 4px 8px">网页版直连 192.168.66.1；手机若默认走移动数据会失败，建议用 App 版。</div>'}
    <iframe class="smart-frame" src="${url}" allow="clipboard-write"></iframe>
  </div>`;
}

/* ------------------------------ view: sms ------------------------------ */
function viewSms(s) {
  const available = s.ttyList && s.ttyList.length > 0;
  return `
  <div class="page">
    <div class="section-title">短信</div>
    <section class="card">
      <div class="card-head">
        <div class="card-title">${ICON_SMS} 短信通道</div>
        <span class="badge ${available ? "" : "off"}">${available ? "可用" : "未检测到"}</span>
      </div>
      ${available
        ? `<div class="note">检测到串口：${esc(s.ttyList.join("、"))}。在下方编辑并发送短信。</div>
           <div class="field" style="margin-top:14px"><label>号码</label><input class="input" id="sms-to" value="${esc(state.sms.to)}" placeholder="+8613800138000" inputmode="tel"/></div>
           <div class="field"><label>内容</label><input class="input" id="sms-body" value="${esc(state.sms.body)}" placeholder="短信内容"/></div>
           <button class="btn" data-action="sms-send">发送短信</button>`
        : `<div class="empty empty-big">
             <div class="ico">${ICON_SMS}</div>
             <div>这台 CPE 没有暴露短信串口</div>
           </div>
           <div class="note">
             5G 模组：${esc(s.modem.vendor || "--")}:${esc(s.modem.product || "--")}（USB RNDIS）。
             当前固件把模组当作 <b>usb0</b> 网卡拨号，没有生成 /dev/ttyUSB* 或 /dev/ttyACM*，
             所以 ubus 和 sms_tool 都没有可用的 AT 通道。
           </div>`}
    </section>

    <section class="card flat">
      <div class="card-title">排查建议</div>
      <div class="note">
        1. 在 LuCI「软件包」安装 <b>kmod-usb-serial-option</b> 后重启，模组通常会生成 /dev/ttyUSB2 等 AT 口；<br />
        2. 本页会自动重新检测，检测到后即可发送短信；<br />
        3. 若模组只支持 RNDIS，短信需要通过模组厂商工具或换用 QMI/MBIM 驱动访问，网页端无法直接读取。
      </div>
    </section>
  </div>`;
}

/* ------------------------------ view: more ------------------------------ */
function luciLink(path, label) {
  return `<button class="luci-link" data-action="luci-page" data-path="${path}">${esc(label)}</button>`;
}

function wallpaperCard() {
  const w = state.wallpaper;
  const active = w && w.kind === "preset" ? w.id : "";
  const blur = w ? (w.blur || 0) : 0;
  const dim = w ? Math.round((w.dim == null ? 0.25 : w.dim) * 100) : 25;
  return `<section class="card">
    <div class="card-head">
      <div class="card-title">${ICON_THEME} DIY 壁纸</div>
      <span class="badge ${w ? "" : "off"}">${w ? (w.kind === "custom" ? "自定义" : "已开启") : "默认"}</span>
    </div>
    <div class="wall-grid">
      ${WALL_ORDER.map((id) => `<button class="wall-thumb ${active === id ? "on" : ""}" data-action="wall-preset" data-id="${id}" style="background:${WALLS[id].css}"></button>`).join("")}
    </div>
    <div class="tool-row"><label>模糊</label><input class="wall-range" type="range" id="wall-blur" min="0" max="24" value="${blur}" /><span class="wall-val" id="wall-blur-val">${blur}px</span></div>
    <div class="tool-row"><label>暗度</label><input class="wall-range" type="range" id="wall-dim" min="0" max="60" value="${dim}" /><span class="wall-val" id="wall-dim-val">${dim}%</span></div>
    <div class="btn-row">
      <button class="btn ghost small" data-action="wall-upload">自定义图片</button>
      <button class="btn quiet small" data-action="wall-off">恢复默认</button>
    </div>
    <div class="note">图片压缩后只保存在本机；App 版会打开系统相册选择。</div>
  </section>`;
}

function viewMore(s) {
  return `
  <div class="page">
    <div class="section-title">设备</div>
    <section class="card">
      ${kv("型号", s.model)}
      ${kv("主机名", s.hostname, true)}
      ${kv("固件", s.firmware + (s.revision ? " · " + s.revision : ""), true)}
      ${kv("内核", s.kernel, true)}
      ${kv("硬件", s.system, true)}
      ${kv("运行时间", fmtUptime(s.uptime))}
      ${kv("CPU 占用", s.cpu == null ? "--" : s.cpu + "%")}
    </section>

    <div class="section-title">外观</div>
    ${wallpaperCard()}

    <div class="section-title">5G 通信壳</div>
    ${smartCard()}

    <div class="section-title">操作</div>
    <section class="card">
      <div class="btn-row" style="margin-bottom:10px">
        <button class="btn ghost small" data-action="luci">打开 LuCI</button>
        <button class="btn quiet small" data-action="wifi-reload">重启 Wi-Fi</button>
      </div>
      <div class="btn-row">
        <button class="btn quiet small" data-action="ifup">重新拨号</button>
        <button class="btn danger small" data-action="reboot">重启路由器</button>
      </div>
      <div class="note">重启 Wi-Fi 会断开无线终端约 10 秒；重新拨号会让 WAN 重新获取地址。</div>
    </section>

    <div class="section-title">LuCI 应用</div>
    <section class="card">
      <div class="luci-grid">
        ${luciLink("admin/status/overview", "状态总览")}
        ${luciLink("admin/network/wireless", "无线设置")}
        ${luciLink("admin/network/firewall", "防火墙")}
        ${luciLink("admin/network/dhcp", "DHCP / DNS")}
        ${luciLink("admin/system/package-manager", "软件包")}
        ${luciLink("admin/status/logs", "系统日志")}
        ${luciLink("admin/system/crontab", "计划任务")}
        ${luciLink("admin/system/startup", "启动项")}
        ${luciLink("admin/services/watchcat", "看门狗")}
        ${luciLink("admin/services/upnp", "UPnP")}
        ${luciLink("admin/network/wireguard", "WireGuard")}
        ${luciLink("admin/network/guest-wifi", "访客 WiFi")}
        ${luciLink("admin/status/processes", "进程管理")}
        ${luciLink("admin/status/realtime", "实时流量")}
        ${luciLink("admin/system/flash", "备份 / 升级")}
        ${luciLink("admin/system/argon-config", "Argon 主题")}
      </div>
      <div class="note">在应用内打开 LuCI 原生页面；首次进入需要用 root 登录一次。</div>
    </section>

    <div class="section-title">系统日志</div>
    <section class="card">
      <div class="card-head">
        <div class="card-title">最近 120 行</div>
        <button class="card-action" data-action="logs">${state.logText ? "刷新" : "加载"}</button>
      </div>
      ${state.logText ? '<div class="logbox">' + esc(state.logText) + "</div>" : '<div class="empty">点右上角加载 logread 日志</div>'}
    </section>

    <div class="section-title">诊断</div>
    <section class="card">
      <div class="card-head">
        <div class="card-title">连通性测试</div>
        <button class="card-action" data-action="ping">运行</button>
      </div>
      ${state.diagText ? '<div class="logbox">' + esc(state.diagText) + "</div>" : '<div class="empty">ping 223.5.5.5，检查 WAN 是否通</div>'}
    </section>

    <section class="card flat">
      <div class="btn-row">
        <button class="btn quiet" data-action="logout">退出登录</button>
      </div>
      <div class="note" style="text-align:center">手搓CPE v${APP_VERSION} · 数据通道 ubus + file.exec · 凭据只保存在本机浏览器</div>
    </section>
  </div>`;
}

/* ------------------------------ icons ------------------------------ */
const stroke = (paths) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
const ICON_HOME = stroke('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>');
const ICON_NET = stroke('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/>');
const ICON_SMS = stroke('<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 4"/>');
const ICON_MORE = stroke('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>');
const ICON_TOOLS = stroke('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.3 2.3-2-2 2.3-2.3Z"/>');
const ICON_THEME = stroke('<path d="M12 3a6.5 6.5 0 0 0 0 13 8.5 8.5 0 0 1 0-13Z"/><path d="M19 5v4M17 7h4"/>');
const ICON_LINK = stroke('<path d="M10 14a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>');
const ICON_PULSE = stroke('<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>');
const ICON_REFRESH = stroke('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>');
const ICON_WIFI = stroke('<path d="M2 8.5a16 16 0 0 1 20 0"/><path d="M5.5 12a11 11 0 0 1 13 0"/><path d="M9 15.5a6 6 0 0 1 6 0"/><circle cx="12" cy="19" r="1"/>');
const ICON_PHONE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>';
const ICON_DEVICE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/></svg>';
const SPIN = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>';

/* ------------------------------ sparkline ------------------------------ */
function drawSpark() {
  const canvas = $("#spark");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 320;
  const h = 68;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const data = samples.slice(-40);
  if (data.length < 2) return;
  while (data.length < 12) data.unshift({ down: 0, up: 0 });
  const max = Math.max(...data.map((d) => Math.max(d.down, d.up)), 1);
  const step = w / Math.max(1, data.length - 1);
  const draw = (key, color, fill) => {
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = i * step;
      const y = h - 6 - (d[key] / max) * (h - 12);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (fill) {
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "rgba(61,220,151,0.28)");
      grad.addColorStop(1, "rgba(61,220,151,0)");
      ctx.fillStyle = grad;
      ctx.fill();
    }
  };
  draw("up", "rgba(90,176,255,0.75)", false);
  draw("down", "#3ddc97", true);
}

/* ------------------------------ render / events ------------------------------ */
function render() {
  applyTheme();
  applyWallpaper();
  const root = $("#app");
  root.innerHTML = state.authed && state.snap ? viewApp() : viewLogin();
  drawSpark();
  if (state.authed && state.demo && state.page) { /* demo stays static */ }
}

document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "wall-file" && e.target.files && e.target.files[0]) {
    readWallFile(e.target.files[0]);
    e.target.value = "";
  }
});

document.addEventListener("input", (e) => {
  const t = e.target;
  if (!t || (t.id !== "wall-blur" && t.id !== "wall-dim")) return;
  if (!state.wallpaper) state.wallpaper = { kind: "preset", id: "forest", blur: 0, dim: 0.25 };
  if (t.id === "wall-blur") {
    state.wallpaper.blur = Number(t.value);
    const v = $("#wall-blur-val");
    if (v) v.textContent = t.value + "px";
  } else {
    state.wallpaper.dim = Number(t.value) / 100;
    const v = $("#wall-dim-val");
    if (v) v.textContent = t.value + "%";
  }
  applyWallpaper();
  clearTimeout(wallSaveTimer);
  wallSaveTimer = setTimeout(saveWallpaper, 250);
});

document.addEventListener("submit", (e) => {
  if (e.target && e.target.id === "login-form") {
    e.preventDefault();
    void doLogin();
  }
});

document.addEventListener("click", async (e) => {
  const pageBtn = e.target.closest("[data-page]");
  if (pageBtn) {
    state.page = pageBtn.dataset.page;
    state.error = "";
    render();
    if (state.page === "tools" && !state.tools && !state.toolsLoading) void loadTools();
    return;
  }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  if (action === "demo") { enterDemo(); return; }
  if (action === "theme") {
    const idx = THEMES.indexOf(state.theme);
    state.theme = THEMES[(idx + 1) % THEMES.length];
    LS.set("cpe.theme", state.theme);
    applyTheme();
    render();
    toast("主题：" + THEME_NAME[state.theme]);
    return;
  }
  if (action === "wall-preset") {
    const id = el.dataset.id;
    if (!WALLS[id]) return;
    state.wallpaper = { kind: "preset", id, blur: state.wallpaper ? state.wallpaper.blur || 0 : 0, dim: state.wallpaper && state.wallpaper.dim != null ? state.wallpaper.dim : 0.25 };
    saveWallpaper();
    applyWallpaper();
    render();
    toast("壁纸：" + WALLS[id].name);
    return;
  }
  if (action === "wall-off") {
    state.wallpaper = null;
    saveWallpaper();
    applyWallpaper();
    render();
    toast("已恢复默认背景");
    return;
  }
  if (action === "wall-upload") {
    const input = $("#wall-file");
    if (input) input.click();
    return;
  }
  if (action === "smart") {
    state.page = "smart";
    render();
    return;
  }
  if (action === "smart-reload") {
    render();
    return;
  }
  if (action === "smart-external") {
    const url = "http://192.168.66.1:9527/";
    if (native.available()) location.href = url;
    else window.open(url, "_blank", "noopener");
    return;
  }
  if (action === "refresh") { state.loading = true; render(); await refresh(); return; }
  if (action === "ping-quality") {
    if (state.demo) { state.quality = { avg: 23.4, jitter: 1.2, min: 21, max: 26, at: Date.now() }; render(); return; }
    state.quality = { loading: true };
    render();
    try {
      const res = await shell("ping -c 4 -W 2 223.5.5.5 2>&1");
      const m = String(res.stdout || "").match(
        new RegExp("(?:rtt|round-trip) min/avg/max(?:/mdev)? = ([0-9.]+)/([0-9.]+)/([0-9.]+)(?:/([0-9.]+))?"),
      );
      if (!m) throw new Error("ping 失败（公网可能不通）");
      const min = Number(m[1]), avg = Number(m[2]), max = Number(m[3]);
      state.quality = { min, avg, max, jitter: m[4] ? Number(m[4]) : (max - min) / 2, at: Date.now() };
    } catch (err) {
      state.quality = { error: err.message || "测速失败" };
    }
    render();
    return;
  }
  if (action === "logout") { logout(); return; }
  if (action === "luci") {
    if (state.demo) { toast("演示模式没有 LuCI"); return; }
    const url = "http://" + state.router + "/cgi-bin/luci";
    if (native.available()) { location.href = url; return; }
    window.open(url, "_blank", "noopener");
    return;
  }
  if (action === "luci-page") {
    const page = el.dataset.path || "admin/status/overview";
    if (!/^[A-Za-z0-9/_-]+$/.test(page)) { toast("页面路径不合法"); return; }
    const url = "http://" + state.router + "/cgi-bin/luci/" + page;
    if (native.available()) { location.href = url; return; }
    window.open(url, "_blank", "noopener");
    return;
  }
  if (action === "reboot") {
    if (state.demo) { toast("演示模式不会重启路由器"); return; }
    openSheet("重启路由器？", "<p>路由器会立刻断开，约 1 分钟后恢复。重启期间本页会失去连接。</p>", [
      { label: "取消", kind: "quiet" },
      { label: "确认重启", kind: "danger", run: async () => {
        try {
          await call("system", "reboot");
          toast("重启指令已发出");
          logout("路由器正在重启，约 1 分钟后重新登录");
        } catch (err) { toast(err.message || "重启失败"); }
      } },
    ]);
    return;
  }
  if (action === "wifi-reload") {
    if (state.demo) { toast("演示模式不执行操作"); return; }
    openSheet("重启 Wi-Fi？", "<p>无线会重启一次，已连接的终端会短暂掉线。</p>", [
      { label: "取消", kind: "quiet" },
      { label: "确认", kind: "ghost", run: async () => {
        try {
          await shell("wifi reload");
          toast("Wi-Fi 正在重启");
          setTimeout(() => void refresh(), 4000);
        } catch (err) { toast(err.message || "操作失败"); }
      } },
    ]);
    return;
  }
  if (action === "ifup") {
    if (state.demo) { toast("演示模式不执行操作"); return; }
    openSheet("重新拨号？", "<p>会重新启动 WAN 接口（USB/wan），短暂断网后重新获取地址。</p>", [
      { label: "取消", kind: "quiet" },
      { label: "确认", kind: "ghost", run: async () => {
        try {
          await shell("ifup USB 2>/dev/null; ifup wan 2>/dev/null; ifup USBWAN6 2>/dev/null; true");
          toast("已重新拨号");
          setTimeout(() => void refresh(), 4000);
        } catch (err) { toast(err.message || "操作失败"); }
      } },
    ]);
    return;
  }
  if (action === "logs") {
    if (state.demo) { state.logText = "演示模式：日志不可用"; render(); return; }
    toast("正在读取日志…");
    try {
      const res = await shell("logread | tail -n 120");
      state.logText = (res.stdout || "").trim() || "（没有日志）";
      render();
    } catch (err) { toast(err.message || "读取日志失败"); }
    return;
  }
  if (action === "ping") {
    if (state.demo) { state.diagText = "演示模式：ping 不可用"; render(); return; }
    toast("正在 ping 223.5.5.5…");
    try {
      const res = await shell("ping -c 3 -W 2 223.5.5.5 2>&1");
      state.diagText = (res.stdout || res.stderr || "").trim() || "（没有输出）";
      render();
    } catch (err) { toast(err.message || "ping 失败"); }
    return;
  }

  if (action === "tool-reload") {
    state.tools = null;
    state.toolsError = "";
    void loadTools();
    return;
  }
  if (action === "tool-wifi") {
    const c24 = ($("#ch24") || {}).value || "auto";
    const c5 = ($("#ch5") || {}).value || "auto";
    const ok24 = ["auto", "1", "6", "11"];
    const ok5 = ["auto", "36", "40", "44", "48", "149", "153", "157", "161"];
    if (!ok24.includes(c24) || !ok5.includes(c5)) { toast("信道取值不合法"); return; }
    await applyTools(
      "uci set 'wireless.radio0.channel=" + c24 + "'; uci set 'wireless.radio1.channel=" + c5 + "'; uci commit wireless; wifi reload",
      "信道已应用，无线重启中",
    );
    return;
  }
  if (action === "tool-tr") {
    const enable = Boolean($("#tr-enable") && $("#tr-enable").checked);
    const hour = Number(($("#tr-hour") || {}).value);
    const minute = Number(($("#tr-minute") || {}).value);
    const week = Number(($("#tr-week") || {}).value);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) { toast("小时需在 0-23 之间"); return; }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) { toast("分钟需在 0-59 之间"); return; }
    if (!Number.isInteger(week) || week < 0 || week > 6) { toast("星期取值不合法"); return; }
    await applyTools(
      "uci set 'timedreboot.@main[0].enable=" + (enable ? 1 : 0) + "'; " +
      "uci set 'timedreboot.@main[0].hour=" + hour + "'; " +
      "uci set 'timedreboot.@main[0].minute=" + minute + "'; " +
      "uci set 'timedreboot.@main[0].week=" + week + "'; " +
      "uci set 'timedreboot.@main[0].once=0'; uci commit timedreboot; /etc/init.d/timedreboot restart",
      enable ? "定时重启已保存" : "定时重启已关闭",
    );
    return;
  }
  if (action === "tool-wc") {
    const enable = Boolean($("#wc-enable") && $("#wc-enable").checked);
    const period = ($("#wc-period") || {}).value || "6h";
    const hosts = (($("#wc-hosts") || {}).value || "").trim();
    if (!["30m", "1h", "3h", "6h", "12h", "24h"].includes(period)) { toast("周期不合法"); return; }
    if (!/^[A-Za-z0-9.,:\s-]+$/.test(hosts)) { toast("Ping 目标格式不对"); return; }
    await applyTools(
      "uci set 'watchcat.@watchcat[0].period=" + period + "'; " +
      "uci set 'watchcat.@watchcat[0].pinghosts=" + hosts + "'; " +
      "uci commit watchcat; " +
      (enable
        ? "/etc/init.d/watchcat enable >/dev/null 2>&1; /etc/init.d/watchcat restart"
        : "/etc/init.d/watchcat disable >/dev/null 2>&1; /etc/init.d/watchcat stop"),
      "看门狗设置已保存",
    );
    return;
  }
  if (action === "tool-fan") {
    const on = Boolean($("#fan") && $("#fan").checked);
    await applyTools(
      "uci set 'luci-fan.@luci-fan[0].enabled=" + (on ? 1 : 0) + "'; uci commit luci-fan; /etc/init.d/luci-fan restart",
      "风扇设置已保存",
    );
    return;
  }
  if (action === "tool-turbo") {
    const v = (id) => (Boolean($("#" + id) && $("#" + id).checked) ? 1 : 0);
    await applyTools(
      "uci set 'turboacc.config.sw_flow=" + v("tb-sw") + "'; " +
      "uci set 'turboacc.config.hw_flow=" + v("tb-hw") + "'; " +
      "uci set 'turboacc.config.sfe_flow=" + v("tb-sfe") + "'; " +
      "uci set 'turboacc.config.fullcone_nat=" + v("tb-fc") + "'; " +
      "uci set 'turboacc.config.bbr_cca=" + v("tb-bbr") + "'; " +
      "uci commit turboacc; /etc/init.d/turboacc restart",
      "TurboACC 已应用",
    );
    return;
  }
  if (action === "tool-upnp") {
    const v = (id) => (Boolean($("#" + id) && $("#" + id).checked) ? 1 : 0);
    await applyTools(
      "uci set 'upnpd.config.enabled=" + v("up-enable") + "'; " +
      "uci set 'upnpd.config.enable_upnp=" + v("up-upnp") + "'; " +
      "uci set 'upnpd.config.enable_natpmp=" + v("up-natpmp") + "'; " +
      "uci commit upnpd; /etc/init.d/miniupnpd restart",
      "UPnP 设置已保存",
    );
    return;
  }
  if (action === "tool-eqos") {
    const enable = Boolean($("#eq-enable") && $("#eq-enable").checked);
    const down = Number(($("#eq-down") || {}).value);
    const up = Number(($("#eq-up") || {}).value);
    if (!Number.isFinite(down) || down < 1 || down > 10000) { toast("下行需在 1-10000 Mbps"); return; }
    if (!Number.isFinite(up) || up < 1 || up > 10000) { toast("上行需在 1-10000 Mbps"); return; }
    await applyTools(
      "uci set 'eqosplus.@eqosplus[0].enabled=" + (enable ? 1 : 0) + "'; " +
      "uci set 'eqosplus.@eqosplus[0].download=" + Math.round(down) + "'; " +
      "uci set 'eqosplus.@eqosplus[0].upload=" + Math.round(up) + "'; " +
      "uci commit eqosplus; /etc/init.d/eqosplus restart",
      "限速设置已保存",
    );
    return;
  }
  if (action === "tool-parent") {
    const pc = Boolean($("#pc-en") && $("#pc-en").checked) ? 1 : 0;
    const tc = Boolean($("#tc-en") && $("#tc-en").checked) ? 1 : 0;
    await applyTools(
      "uci set 'parentcontrol.@basic[0].enabled=" + pc + "'; " +
      "uci set 'timecontrol.@timecontrol[0].enabled=" + tc + "'; " +
      "uci commit parentcontrol; uci commit timecontrol; " +
      "/etc/init.d/parentcontrol restart; /etc/init.d/timecontrol restart",
      "家长控制开关已保存",
    );
    return;
  }
  if (action === "tool-cron-save") {
    let text = (($("#cron-text") || {}).value || "").slice(0, 8000);
    if (text && !text.endsWith("\n")) text += "\n";
    await applyTools(
      "printf '%s' " + shq(text) + " > /etc/crontabs/root; /etc/init.d/cron restart",
      "crontab 已保存",
    );
    return;
  }
  if (action === "at-send") {
    const tty = state.tools && state.tools.modem && state.tools.modem[0];
    if (!tty) { toast("没有 AT 串口"); return; }
    const cmd = (($("#at-cmd") || {}).value || "").trim();
    if (!/^[A-Za-z0-9+?=,\"':._ -]+$/.test(cmd)) { toast("命令含有不支持的字符"); return; }
    try {
      const res = await shell("sms_tool -d " + tty + " at " + JSON.stringify(cmd) + " 2>&1");
      state.atOut = (res.stdout || "").trim() || "（无输出）";
    } catch (err) { state.atOut = err.message || "发送失败"; }
    render();
    return;
  }

  if (action === "sms-send") {
    if (state.demo) { toast("演示模式不会发短信"); return; }
    const to = ($("#sms-to") || {}).value || "";
    const body = ($("#sms-body") || {}).value || "";
    state.sms.to = to;
    state.sms.body = body;
    if (!to || !body) { toast("请填写号码和内容"); return; }
    try {
      const dev = state.snap.ttyList[0];
      const res = await shell("sms_tool -d " + shq(dev) + " send " + shq(to) + " " + shq(body) + " 2>&1");
      const out = (res.stdout || "").trim();
      toast(out ? out.slice(0, 60) : "短信已交给模组");
      state.sms.body = "";
      render();
    } catch (err) { toast(err.message || "发送失败"); }
    return;
  }
});

$("#sheet").addEventListener("click", (e) => {
  if (e.target.id === "sheet") closeSheet();
});

/* ------------------------------ boot ------------------------------ */
state.loading = true;
render();
if (state.pass) {
  state.busy = true;
  render();
  void doLogin();
  schedule();
} else {
  state.busy = false;
  state.loading = false;
  render();
  schedule();
}
