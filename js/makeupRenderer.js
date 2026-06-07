// 渲染层：每帧把「妆容方案 JSON」画到 canvas 上。
// 关键：canvas 每帧先画视频帧（见 main.js），妆容再叠在上面，
// 这样 multiply / soft-light 才真正和皮肤纹理混合，而不是浮在表面像贴纸。
// 设计纪律：不调任何网络/大模型；只读 landmarks + makeup 参数，纯绘制。
import {
  LIPS_OUTER,
  LIPS_INNER,
  RIGHT_EYE,
  LEFT_EYE,
  RIGHT_CHEEK,
  LEFT_CHEEK,
  RIGHT_EYEBROW,
  LEFT_EYEBROW,
  FACE_LEFT,
  FACE_RIGHT,
} from "./landmarks.js";

// 把归一化点 (0..1) 映射到画布像素。支持水平镜像（自拍体验）。
function toPx(pt, w, h, mirror) {
  const x = mirror ? (1 - pt.x) * w : pt.x * w;
  return { x, y: pt.y * h };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 估计脸宽（像素），用于尺寸/羽化自适应
function faceWidth(landmarks, w, h, mirror) {
  const l = toPx(landmarks[FACE_LEFT], w, h, mirror);
  const r = toPx(landmarks[FACE_RIGHT], w, h, mirror);
  return dist(l, r);
}

// 浏览器是否支持 canvas filter（iOS 旧版可能不支持，退化为硬边缘但不报错）
let _filterSupported = null;
function filterSupported(ctx) {
  if (_filterSupported === null) {
    _filterSupported = typeof ctx.filter === "string";
  }
  return _filterSupported;
}

// ---- 嘴唇 ----
// 嘴唇外轮廓的几何中心，用于把外轮廓向内收缩，抵消羽化外扩
function lipCentroid(landmarks, w, h, mirror) {
  let sx = 0, sy = 0;
  for (const i of LIPS_OUTER) {
    const p = toPx(landmarks[i], w, h, mirror);
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / LIPS_OUTER.length, y: sy / LIPS_OUTER.length };
}

// 在 ctx 上构造嘴唇路径（外轮廓减内轮廓，evenodd 挖空口腔）。
// ox/oy：平移到遮罩画布的局部坐标系。
// shrink：外轮廓向中心收缩比例（0~1），用来把羽化后的着色边压回唇线内。
function lipPath(ctx, landmarks, w, h, mirror, ox = 0, oy = 0, shrink = 0) {
  const c = shrink > 0 ? lipCentroid(landmarks, w, h, mirror) : null;
  ctx.beginPath();
  LIPS_OUTER.forEach((i, n) => {
    let p = toPx(landmarks[i], w, h, mirror);
    if (c) p = { x: p.x + (c.x - p.x) * shrink, y: p.y + (c.y - p.y) * shrink };
    n === 0 ? ctx.moveTo(p.x - ox, p.y - oy) : ctx.lineTo(p.x - ox, p.y - oy);
  });
  ctx.closePath();
  LIPS_INNER.forEach((i, n) => {
    const p = toPx(landmarks[i], w, h, mirror);
    n === 0 ? ctx.moveTo(p.x - ox, p.y - oy) : ctx.lineTo(p.x - ox, p.y - oy);
  });
  ctx.closePath();
}

// 嘴唇外轮廓的整数包围盒（含羽化留白），用于只处理这一小块像素
function lipBBox(landmarks, w, h, mirror, pad) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const i of LIPS_OUTER) {
    const p = toPx(landmarks[i], w, h, mirror);
    if (p.x < minx) minx = p.x;
    if (p.y < miny) miny = p.y;
    if (p.x > maxx) maxx = p.x;
    if (p.y > maxy) maxy = p.y;
  }
  const x = Math.max(0, Math.floor(minx - pad));
  const y = Math.max(0, Math.floor(miny - pad));
  const x2 = Math.min(w, Math.ceil(maxx + pad));
  const y2 = Math.min(h, Math.ceil(maxy + pad));
  return { x, y, bw: Math.max(0, x2 - x), bh: Math.max(0, y2 - y) };
}

// 复用的离屏遮罩画布（羽化后的唇区覆盖度）
let _maskCanvas = null;
let _maskCtx = null;
function maskCtx() {
  if (!_maskCanvas) {
    _maskCanvas = document.createElement("canvas");
    _maskCtx = _maskCanvas.getContext("2d", { willReadFrequently: true });
  }
  return _maskCtx;
}

// 唇色跟随光照：逐像素读皮肤亮度 → 高光少上色（透出水光）、阴影多上色（立体）。
// 这是 Canvas 2D 里性价比最高的自然度提升。getImageData 失败时退回 drawLipsFlat。
// 唇形向内收缩比例：抵消羽化外扩，避免颜色超出唇线（嘴越小越明显）
const LIP_SHRINK = 0.07;

function drawLipsLit(ctx, landmarks, w, h, mirror, lips, fw) {
  const blur = Math.max(1, fw * 0.006); // 羽化更收敛
  const pad = Math.ceil(blur * 2 + 2);
  const { x, y, bw, bh } = lipBBox(landmarks, w, h, mirror, pad);
  if (bw < 2 || bh < 2) return;

  // 1) 羽化遮罩：收缩后的白色唇形画到离屏画布，其 alpha 即每像素覆盖度
  const mctx = maskCtx();
  mctx.canvas.width = bw;
  mctx.canvas.height = bh;
  mctx.clearRect(0, 0, bw, bh);
  mctx.save();
  if (filterSupported(mctx)) mctx.filter = `blur(${blur}px)`;
  mctx.fillStyle = "#fff";
  lipPath(mctx, landmarks, w, h, mirror, x, y, LIP_SHRINK); // 平移+内缩
  mctx.fill("evenodd");
  mctx.restore();

  let mask, skin;
  try {
    mask = mctx.getImageData(0, 0, bw, bh).data;
    skin = ctx.getImageData(x, y, bw, bh); // 此刻 ctx 已画好视频帧 → 真实皮肤
  } catch (e) {
    // 跨域污染等异常：退回简单 multiply 版
    drawLipsFlat(ctx, landmarks, w, h, mirror, lips, fw);
    return;
  }
  const data = skin.data;

  // 唇色（0..1）
  const c = hexToRgb(lips.color);
  const lr = c.r / 255, lg = c.g / 255, lb = c.b / 255;
  const opacity = lips.opacity ?? 0.5;
  const HILIGHT_KEEP = 0.55; // 高光处保留多少原图（越大越透、越显水光）
  const moist = lips.style !== "matte";
  const GLOSS = moist ? 0.9 : 0.25; // 水光强度

  const EDGE = 0.25; // 低于此覆盖度的外圈淡边直接裁掉，杜绝溢出唇线
  for (let i = 0; i < data.length; i += 4) {
    const raw = mask[i + 3] / 255;
    if (raw <= EDGE) continue;
    const cover = (raw - EDGE) / (1 - EDGE); // 重映射到 0..1，保留内侧柔和过渡

    const r = data[i], g = data[i + 1], b = data[i + 2];
    const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255; // 皮肤亮度 0..1

    // 与皮肤相乘得到"染色"色（透出唇纹），再按亮度调上色量：暗处浓、亮处淡
    const tr = r * lr, tg = g * lg, tb = b * lb;
    let amt = opacity * cover * (1 - L * HILIGHT_KEEP);

    let or_ = r + (tr - r) * amt;
    let og = g + (tg - g) * amt;
    let ob = b + (tb - b) * amt;

    // 水光高光：很亮的像素叠一层白,做出湿润反光
    if (L > 0.78) {
      const gloss = ((L - 0.78) / 0.22) * GLOSS * cover;
      or_ += (255 - or_) * gloss;
      og += (255 - og) * gloss;
      ob += (255 - ob) * gloss;
    }

    data[i] = or_; data[i + 1] = og; data[i + 2] = ob;
  }

  // 整块写回（含未上妆像素＝原皮肤，所以直接覆盖该矩形是安全的）
  ctx.putImageData(skin, x, y);
}

// 兜底：旧的 multiply 多边形填充（getImageData 不可用时）
function drawLipsFlat(ctx, landmarks, w, h, mirror, lips, fw) {
  const blur = Math.max(1, fw * 0.006);
  ctx.save();
  if (filterSupported(ctx)) ctx.filter = `blur(${blur}px)`;
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = lips.opacity ?? 0.5;
  ctx.fillStyle = lips.color;
  lipPath(ctx, landmarks, w, h, mirror, 0, 0, LIP_SHRINK);
  ctx.fill("evenodd");
  ctx.restore();
}

function drawLips(ctx, landmarks, w, h, mirror, lips, fw) {
  if (!lips) return;
  drawLipsLit(ctx, landmarks, w, h, mirror, lips, fw);
}

// ---- 眼影：每只眼睛一层柔和径向渐变（本就羽化，自然）----
function drawEyeshadowFor(ctx, landmarks, w, h, mirror, eye, shadow) {
  const inner = toPx(landmarks[eye.inner], w, h, mirror);
  const outer = toPx(landmarks[eye.outer], w, h, mirror);
  const top = toPx(landmarks[eye.top], w, h, mirror);
  const center = { x: (inner.x + outer.x) / 2, y: (inner.y + outer.y) / 2 };
  const eyeW = dist(inner, outer);

  const cx = center.x;
  const cy = top.y - eyeW * 0.12;
  const rx = eyeW * 0.72;
  const ry = eyeW * 0.5;

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = shadow.opacity ?? 0.4;
  const grad = ctx.createRadialGradient(cx, cy, eyeW * 0.05, cx, cy, rx);
  grad.addColorStop(0, shadow.color);
  grad.addColorStop(1, hexToRgba(shadow.color, 0)); // 边缘羽化到透明
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawEyeshadow(ctx, landmarks, w, h, mirror, shadow) {
  if (!shadow) return;
  drawEyeshadowFor(ctx, landmarks, w, h, mirror, LEFT_EYE, shadow);
  drawEyeshadowFor(ctx, landmarks, w, h, mirror, RIGHT_EYE, shadow);
}

// ---- 腮红：苹果肌上的柔和渐变圆 ----
function drawBlushFor(ctx, center, radius, blush) {
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = blush.opacity ?? 0.3;
  const grad = ctx.createRadialGradient(
    center.x,
    center.y,
    radius * 0.1,
    center.x,
    center.y,
    radius
  );
  grad.addColorStop(0, blush.color);
  grad.addColorStop(1, hexToRgba(blush.color, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBlush(ctx, landmarks, w, h, mirror, blush) {
  if (!blush) return;
  const fw = faceWidth(landmarks, w, h, mirror);
  const r = fw * 0.13;
  drawBlushFor(ctx, toPx(landmarks[RIGHT_CHEEK], w, h, mirror), r, blush);
  drawBlushFor(ctx, toPx(landmarks[LEFT_CHEEK], w, h, mirror), r, blush);
}

// ---- 眉毛：沿眉形细长多边形低透明度加深 + 羽化 ----
function drawEyebrowFor(ctx, landmarks, w, h, mirror, indices, brow, fw) {
  ctx.save();
  if (filterSupported(ctx)) ctx.filter = `blur(${Math.max(1, fw * 0.004)}px)`;
  ctx.beginPath();
  indices.forEach((i, n) => {
    const p = toPx(landmarks[i], w, h, mirror);
    n === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = (brow.opacity ?? 0.5) * 0.6;
  ctx.fillStyle = brow.color;
  ctx.fill();
  ctx.restore();
}

function drawEyebrow(ctx, landmarks, w, h, mirror, brow, fw) {
  if (!brow) return;
  drawEyebrowFor(ctx, landmarks, w, h, mirror, RIGHT_EYEBROW, brow, fw);
  drawEyebrowFor(ctx, landmarks, w, h, mirror, LEFT_EYEBROW, brow, fw);
}

// 十六进制颜色 → {r,g,b}
function hexToRgb(hex) {
  const m = hex.replace("#", "");
  const bigint = parseInt(
    m.length === 3
      ? m
          .split("")
          .map((c) => c + c)
          .join("")
      : m,
    16
  );
  return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
}

// 十六进制颜色 + alpha → rgba()，用于渐变边缘羽化
function hexToRgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 主入口：在「已画好视频帧」的 ctx 上叠加妆容。
// 注意：不再 clearRect —— 底图是视频，由 main.js 每帧先画。
// makeup 为 null（裸脸）时不画任何东西。
export function renderMakeup(ctx, landmarks, makeup, { mirror = true } = {}) {
  if (!makeup || !landmarks) return;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const fw = faceWidth(landmarks, w, h, mirror);

  // 顺序：底层（眼影/腮红）→ 上层（眉、唇），叠加更自然
  drawEyeshadow(ctx, landmarks, w, h, mirror, makeup.eyeshadow);
  drawBlush(ctx, landmarks, w, h, mirror, makeup.blush);
  drawEyebrow(ctx, landmarks, w, h, mirror, makeup.eyebrow, fw);
  drawLips(ctx, landmarks, w, h, mirror, makeup.lips, fw);
}
