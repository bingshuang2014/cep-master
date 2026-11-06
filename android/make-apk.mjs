#!/usr/bin/env node
/**
 * 手写 Binary XML (AXML) 清单 + APK zip，不依赖 aapt。
 * aapt 在这台 ARM 设备上因 libc++ 符号缺失无法运行；这里直接生成规范格式。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = process.env.APK_ROOT || path.dirname(fileURLToPath(import.meta.url));
const NS_URI = "http://schemas.android.com/apk/res/android";

/* ---------- string pool ---------- */
const strings = [];
const index = new Map();
function intern(s) {
  if (!index.has(s)) { index.set(s, strings.length); strings.push(s); }
  return index.get(s);
}

/* android attribute resource ids (android.R$attr) */
const ATTR = {
  theme: 16842752, label: 16842753, icon: 16842754, name: 16842755, exported: 16842768,
  screenOrientation: 16842782, configChanges: 16842783, minSdkVersion: 16843276,
  targetSdkVersion: 16843376, versionCode: 16843291, versionName: 16843292,
  allowBackup: 16843392, hardwareAccelerated: 16843475,
};
const DRAWABLE_MANAGE = 17301570;      // @android:drawable/ic_menu_manage
const STYLE_NO_ACTION_BAR = 16974121;  // @android:style/Theme.DeviceDefault.NoActionBar

/* ---------- manifest tree ---------- */
const str = (value) => ({ type: "string", value });
const int = (value) => ({ type: "int", value });
const bool = (value) => ({ type: "bool", value });
const ref = (value) => ({ type: "ref", value });

const manifest = {
  tag: "manifest",
  attrs: [
    { name: "versionCode", value: int(2) },
    { name: "versionName", value: str("1.6.0") },
    { name: "package", value: str("com.dsh.cpepanel"), plain: true },
  ],
  children: [
    { tag: "uses-sdk", attrs: [
      { name: "minSdkVersion", value: int(24) },
      { name: "targetSdkVersion", value: int(27) },
    ] },
    { tag: "uses-permission", attrs: [{ name: "name", value: str("android.permission.INTERNET") }] },
    { tag: "uses-permission", attrs: [{ name: "name", value: str("android.permission.ACCESS_NETWORK_STATE") }] },
    { tag: "application", attrs: [
      { name: "label", value: str("手搓CPE") },
      { name: "icon", value: ref(0x7f010000) },
      { name: "theme", value: ref(STYLE_NO_ACTION_BAR) },
      { name: "allowBackup", value: bool(false) },
      { name: "hardwareAccelerated", value: bool(true) },
    ], children: [
      { tag: "activity", attrs: [
        { name: "name", value: str(".MainActivity") },
        { name: "exported", value: bool(true) },
        { name: "screenOrientation", value: int(1) },
        { name: "configChanges", value: int(0x4a0) },
      ], children: [
        { tag: "intent-filter", attrs: [], children: [
          { tag: "action", attrs: [{ name: "name", value: str("android.intent.action.MAIN") }] },
          { tag: "category", attrs: [{ name: "name", value: str("android.intent.category.LAUNCHER") }] },
        ] },
      ] },
    ] },
  ],
};

/* 预登记字符串：命名空间、标签、属性名、字符串值 */
intern(NS_URI);
intern("android");
function walk(node, line) {
  intern(node.tag);
  for (const a of node.attrs) {
    intern(a.name);
    if (a.value.type === "string") intern(a.value.value);
  }
  for (const child of node.children || []) walk(child, line + 1);
}
walk(manifest, 1);

/* ---------- chunks ---------- */
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const chunk = (type, headerSize, body) => {
  const size = 8 + body.length;
  const head = Buffer.alloc(8);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(size, 4);
  return Buffer.concat([head, body]);
};

function buildStringPool() {
  const dataChunks = [];
  const offsets = [];
  let offset = 0;
  for (const s of strings) {
    const utf8 = Buffer.from(s, "utf8");
    const u16len = s.length;
    const bytes = [];
    const enc = (n) => {
      if (n > 0x7f) { bytes.push(((n >> 8) & 0x7f) | 0x80, n & 0xff); } else bytes.push(n);
    };
    enc(u16len);
    enc(utf8.length);
    offsets.push(offset);
    const b = Buffer.concat([Buffer.from(bytes), utf8, Buffer.from([0])]);
    dataChunks.push(b);
    offset += b.length;
  }
  let data = Buffer.concat(dataChunks);
  const pad = (4 - (data.length % 4)) % 4;
  if (pad) data = Buffer.concat([data, Buffer.alloc(pad)]);
  const headerSize = 28;
  const stringsStart = headerSize + 4 * strings.length;
  const size = stringsStart + data.length;
  const head = Buffer.alloc(headerSize);
  head.writeUInt16LE(0x0001, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(size, 4);
  head.writeUInt32LE(strings.length, 8);
  head.writeUInt32LE(0, 12);
  head.writeUInt32LE(0x00000100, 16); // UTF-8
  head.writeUInt32LE(stringsStart, 20);
  head.writeUInt32LE(0, 24);
  const offsetsBuf = Buffer.alloc(4 * strings.length);
  offsets.forEach((o, i) => offsetsBuf.writeUInt32LE(o, i * 4));
  return Buffer.concat([head, offsetsBuf, data]);
}

function buildResourceMap() {
  const ids = new Array(strings.length).fill(0);
  for (const [name, id] of Object.entries(ATTR)) {
    if (index.has(name)) ids[index.get(name)] = id;
  }
  const body = Buffer.alloc(4 * strings.length);
  ids.forEach((id, i) => body.writeUInt32LE(id, i * 4));
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0180, 0);
  head.writeUInt16LE(8, 2);
  head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

function buildNamespace(start, line) {
  const body = Buffer.concat([
    u32(line), u32(0xffffffff),
    u32(index.get("android")), u32(index.get(NS_URI)),
  ]);
  return chunk(start ? 0x0100 : 0x0101, 16, body);
}

function buildStart(node, line) {
  const attrs = node.attrs.slice().sort((a, b) => (a.plain ? -1 : 0) - (b.plain ? -1 : 0));
  const size = 36 + attrs.length * 20;
  const buf = Buffer.alloc(size);
  buf.writeUInt16LE(0x0102, 0);
  buf.writeUInt16LE(16, 2);
  buf.writeUInt32LE(size, 4);
  buf.writeUInt32LE(line, 8);
  buf.writeUInt32LE(0xffffffff, 12);
  buf.writeUInt32LE(0xffffffff, 16); // element ns: none
  buf.writeUInt32LE(index.get(node.tag), 20);
  buf.writeUInt16LE(20, 24);
  buf.writeUInt16LE(20, 26);
  buf.writeUInt16LE(attrs.length, 28);
  buf.writeUInt16LE(0, 30);
  buf.writeUInt16LE(0, 32);
  buf.writeUInt16LE(0, 34);
  attrs.forEach((a, i) => {
    const off = 36 + i * 20;
    const ns = a.plain ? 0xffffffff : index.get(NS_URI);
    buf.writeUInt32LE(ns, off);
    buf.writeUInt32LE(index.get(a.name), off + 4);
    let raw = 0xffffffff;
    let type = 0x03;
    let data = 0;
    if (a.value.type === "string") {
      data = index.get(a.value.value);
      raw = data;
    } else if (a.value.type === "int") {
      type = 0x10; data = a.value.value;
    } else if (a.value.type === "bool") {
      type = 0x12; data = a.value.value ? 0xffffffff : 0;
    } else if (a.value.type === "ref") {
      type = 0x01; data = a.value.value;
    }
    buf.writeUInt32LE(raw, off + 8);
    buf.writeUInt16LE(8, off + 12);
    buf.writeUInt8(0, off + 14);
    buf.writeUInt8(type, off + 15);
    buf.writeUInt32LE(data >>> 0, off + 16);
  });
  return buf;
}

function buildEnd(node, line) {
  const body = Buffer.concat([u32(line), u32(0xffffffff), u32(0xffffffff), u32(index.get(node.tag))]);
  return chunk(0x0103, 16, body);
}

function buildXml() {
  const parts = [];
  parts.push(buildStringPool());
  parts.push(buildResourceMap());
  parts.push(buildNamespace(true, 1));
  let line = 2;
  const emit = (node) => {
    parts.push(buildStart(node, line));
    for (const child of node.children || []) { line += 1; emit(child); }
    line += 1;
    parts.push(buildEnd(node, line));
  };
  emit(manifest);
  parts.push(buildNamespace(false, 1));
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0003, 0);
  head.writeUInt16LE(8, 2);
  head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

/* ---------- resources.arsc (single mipmap icon) ---------- */
function makePool(list) {
  const chunks = [];
  const offsets = [];
  let off = 0;
  for (const s of list) {
    const utf8 = Buffer.from(s, "utf8");
    const bytes = [];
    const enc = (n) => { if (n > 0x7f) bytes.push(((n >> 8) & 0x7f) | 0x80, n & 0xff); else bytes.push(n); };
    enc(s.length);
    enc(utf8.length);
    offsets.push(off);
    const b = Buffer.concat([Buffer.from(bytes), utf8, Buffer.from([0])]);
    chunks.push(b);
    off += b.length;
  }
  let data = Buffer.concat(chunks);
  const pad = (4 - (data.length % 4)) % 4;
  if (pad) data = Buffer.concat([data, Buffer.alloc(pad)]);
  const headerSize = 28;
  const stringsStart = headerSize + 4 * list.length;
  const size = stringsStart + data.length;
  const head = Buffer.alloc(headerSize);
  head.writeUInt16LE(0x0001, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(size, 4);
  head.writeUInt32LE(list.length, 8);
  head.writeUInt32LE(0, 12);
  head.writeUInt32LE(0x00000100, 16);
  head.writeUInt32LE(stringsStart, 20);
  head.writeUInt32LE(0, 24);
  const offsetsBuf = Buffer.alloc(4 * list.length);
  offsets.forEach((o, i) => offsetsBuf.writeUInt32LE(o, i * 4));
  return Buffer.concat([head, offsetsBuf, data]);
}

function buildResources() {
  const iconPath = "res/mipmap/ic_launcher.png";
  const globalPool = makePool([iconPath]);
  const typePool = makePool(["mipmap"]);
  const keyPool = makePool(["ic_launcher"]);
  const headerSize = 288;
  const pkg = Buffer.alloc(headerSize);
  pkg.writeUInt16LE(0x0200, 0);
  pkg.writeUInt16LE(headerSize, 2);
  pkg.writeUInt32LE(0x7f, 8);
  Buffer.from("com.dsh.cpepanel", "utf16le").copy(pkg, 12);
  pkg.writeUInt32LE(headerSize, 268);
  pkg.writeUInt32LE(1, 272);
  pkg.writeUInt32LE(headerSize + typePool.length, 276);
  pkg.writeUInt32LE(1, 280);
  pkg.writeUInt32LE(0, 284);

  const typeSpec = Buffer.alloc(20);
  typeSpec.writeUInt16LE(0x0202, 0);
  typeSpec.writeUInt16LE(16, 2);
  typeSpec.writeUInt32LE(20, 4);
  typeSpec.writeUInt8(1, 8);
  typeSpec.writeUInt32LE(1, 12);
  typeSpec.writeUInt32LE(0, 16);

  const configSize = 64;
  const typeHeader = 20 + configSize;
  const entriesStart = typeHeader + 4;
  const type = Buffer.alloc(entriesStart + 16);
  type.writeUInt16LE(0x0201, 0);
  type.writeUInt16LE(typeHeader, 2);
  type.writeUInt32LE(type.length, 4);
  type.writeUInt8(1, 8);
  type.writeUInt8(0, 9);
  type.writeUInt16LE(0, 10);
  type.writeUInt32LE(1, 12);
  type.writeUInt32LE(entriesStart, 16);
  type.writeUInt32LE(configSize, 20);
  type.writeUInt32LE(0, typeHeader);
  type.writeUInt16LE(8, entriesStart);
  type.writeUInt16LE(0, entriesStart + 2);
  type.writeUInt32LE(0, entriesStart + 4);
  type.writeUInt16LE(8, entriesStart + 8);
  type.writeUInt8(0, entriesStart + 10);
  type.writeUInt8(0x03, entriesStart + 11);
  type.writeUInt32LE(0, entriesStart + 12);

  const pkgTotal = headerSize + typePool.length + keyPool.length + typeSpec.length + type.length;
  pkg.writeUInt32LE(pkgTotal, 4);
  const packageChunk = Buffer.concat([pkg, typePool, keyPool, typeSpec, type]);

  const total = 12 + globalPool.length + packageChunk.length;
  const head = Buffer.alloc(12);
  head.writeUInt16LE(0x0002, 0);
  head.writeUInt16LE(12, 2);
  head.writeUInt32LE(total, 4);
  head.writeUInt32LE(1, 8);
  return Buffer.concat([head, globalPool, packageChunk]);
}

/* ---------- zip (store) ---------- */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.data;
    const crc = zlib.crc32(data);
    const align = e.align || 1;
    let extraLen = 0;
    if (align > 1) extraLen = (align - ((offset + 30 + name.length) % align)) % align;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8);      // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);  // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extraLen, 28);
    locals.push(local, name, Buffer.alloc(extraLen), data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + extraLen + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const xml = buildXml();
fs.writeFileSync(path.join(ROOT, "app/build/AndroidManifest.xml"), xml);
const assetsDir = path.join(ROOT, "app/assets");
const arsc = buildResources();
const icon = fs.readFileSync(path.join(ROOT, "app/res/mipmap/ic_launcher.png"));
const entries = [
  { name: "AndroidManifest.xml", data: xml },
  { name: "classes.dex", align: 4, data: fs.readFileSync(path.join(ROOT, "app/build/dex/classes.dex")) },
  { name: "resources.arsc", align: 4, data: arsc },
  { name: "res/mipmap/ic_launcher.png", data: icon },
];
for (const file of fs.readdirSync(assetsDir)) {
  entries.push({ name: "assets/" + file, data: fs.readFileSync(path.join(assetsDir, file)) });
}
const apk = zip(entries);
fs.writeFileSync(path.join(ROOT, "app/build/unsigned.apk"), apk);
console.log("manifest bytes", xml.length, "strings", strings.length, "apk bytes", apk.length);
