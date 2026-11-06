#!/usr/bin/env node
// 生成 手搓CPE 图标：渐变圆角方块 + 路由器 + 信号波纹（无外部依赖）
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SIZE = 192;
const SS = 4;
const W = SIZE * SS;
const buf = new Uint8ClampedArray(W * W * 4);

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= W || a <= 0) return;
  const i = (y * W + x) * 4;
  const sa = Math.min(1, a);
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  buf[i] = (r * sa + buf[i] * da * (1 - sa)) / oa;
  buf[i + 1] = (g * sa + buf[i + 1] * da * (1 - sa)) / oa;
  buf[i + 2] = (b * sa + buf[i + 2] * da * (1 - sa)) / oa;
  buf[i + 3] = oa * 255;
}

function roundRect(x0, y0, x1, y1, radius, color) {
  const [r, g, b, a] = color;
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) {
      const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius));
      const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius));
      if (dx * dx + dy * dy <= radius * radius) blend(x, y, r, g, b, a);
    }
  }
}

function circle(cx, cy, rad, color) {
  const [r, g, b, a] = color;
  for (let y = Math.floor(cy - rad); y <= cy + rad; y++) {
    for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= rad) blend(x, y, r, g, b, a * Math.min(1, rad - d + 0.5));
    }
  }
}

function line(x1, y1, x2, y2, width, color) {
  const [r, g, b, a] = color;
  const half = width / 2;
  const minX = Math.floor(Math.min(x1, x2) - half), maxX = Math.ceil(Math.max(x1, x2) + half);
  const minY = Math.floor(Math.min(y1, y2) - half), maxY = Math.ceil(Math.max(y1, y2) + half);
  const vx = x2 - x1, vy = y2 - y1;
  const len2 = vx * vx + vy * vy || 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / len2));
      const px = x1 + t * vx, py = y1 + t * vy;
      const d = Math.hypot(x - px, y - py);
      if (d <= half) blend(x, y, r, g, b, a * Math.min(1, half - d + 0.5));
    }
  }
}

function arc(cx, cy, rad, startDeg, endDeg, width, color) {
  const [r, g, b, a] = color;
  const start = (startDeg * Math.PI) / 180;
  const end = (endDeg * Math.PI) / 180;
  const half = width / 2;
  for (let y = Math.floor(cy - rad - half); y <= cy + rad + half; y++) {
    for (let x = Math.floor(cx - rad - half); x <= cx + rad + half; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(d - rad) > half) continue;
      let ang = Math.atan2(y - cy, x - cx);
      if (ang < 0) ang += Math.PI * 2;
      if (ang < start || ang > end) continue;
      blend(x, y, r, g, b, a);
    }
  }
}

// 背景：圆角方块 + 青→靛渐变
const pad = 24;
const rad = 156;
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const dx = Math.max(pad + rad - x, 0, x - (W - pad - rad));
    const dy = Math.max(pad + rad - y, 0, y - (W - pad - rad));
    if (dx * dx + dy * dy > rad * rad) continue;
    const t = (x / W) * 0.55 + (y / W) * 0.45;
    const r = Math.round(20 + t * 56);
    const g = Math.round(184 - t * 122);
    const b = Math.round(166 + t * 73);
    blend(x, y, r, g, b, 1);
  }
}
// 左上高光
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - W * 0.18, y - W * 0.12);
    if (d < W * 0.55) blend(x, y, 255, 255, 255, 0.18 * (1 - d / (W * 0.55)));
  }
}
// 玻璃描边
for (let i = 0; i < 6; i++) {
  const inset = pad + 6 + i * 3;
  const rr = rad - 6;
  for (let y = inset; y < W - inset; y++) {
    for (let x = inset; x < W - inset; x++) {
      const dx = Math.max(inset + rr - x, 0, x - (W - inset - rr));
      const dy = Math.max(inset + rr - y, 0, y - (W - inset - rr));
      const d = Math.hypot(dx, dy);
      if (Math.abs(d - rr) < 1.6) blend(x, y, 255, 255, 255, 0.18);
    }
  }
}

// 信号波
arc(W / 2, 300, 92, 205, 335, 20, [255, 255, 255, 0.95]);
arc(W / 2, 300, 158, 205, 335, 20, [255, 255, 255, 0.68]);
arc(W / 2, 300, 224, 205, 335, 20, [255, 255, 255, 0.4]);

// 路由器主体
roundRect(196, 424, 572, 566, 52, [255, 255, 255, 0.97]);
roundRect(228, 452, 540, 480, 14, [15, 118, 110, 0.22]);

// 指示灯
circle(268, 522, 15, [52, 211, 153, 1]);
circle(328, 522, 15, [103, 232, 249, 1]);
circle(388, 522, 15, [167, 139, 250, 1]);

// 天线
line(236, 424, 176, 334, 26, [255, 255, 255, 0.92]);
line(532, 424, 592, 334, 26, [255, 255, 255, 0.92]);
circle(176, 332, 13, [255, 255, 255, 1]);
circle(592, 332, 13, [255, 255, 255, 1]);

// 右下光泽
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - W * 0.86, y - W * 0.9);
    if (d < W * 0.4) blend(x, y, 255, 255, 255, 0.10 * (1 - d / (W * 0.4)));
  }
}

// 降采样
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
      }
    }
    const n = SS * SS;
    const o = (y * SIZE + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
  }
}

// PNG 编码
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const dir = path.join(process.argv[2] || ".", "res", "mipmap");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "ic_launcher.png"), png);
console.log("icon", png.length, "bytes ->", path.join(dir, "ic_launcher.png"));
