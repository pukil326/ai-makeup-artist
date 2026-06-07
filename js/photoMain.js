// 「上传照片试妆」工具：上传一张人脸照 → 检测关键点 + 皮肤分割 → AI 出妆容
// → WebGL 静态渲染出效果图 → 可调浓度/前后对比/保存。用来生成 demo 素材。
// 复用实时主程序同一套渲染器（LipGL）+ 模型，照片不镜像。
import { initFaceLandmarker, detect } from "./faceTracking.js";
import { analyze } from "./api.js";
import { LipGL } from "./webgl/lipGL.js";
import { initSegmenter, segment, getSkinCanvas, skinReady } from "./webgl/skinSeg.js";

const glCanvas = document.getElementById("gl");
const fileInput = document.getElementById("file-input");
const uploadHint = document.querySelector(".upload-hint");
const btnAI = document.getElementById("btn-ai");
const btnBare = document.getElementById("btn-bare");
const btnDebug = document.getElementById("btn-debug");
const btnSave = document.getElementById("btn-save");
const statusEl = document.getElementById("status");
const chips = Array.from(document.querySelectorAll(".chip"));
const intensityRange = document.getElementById("intensity-range");
const compareRange = document.getElementById("compare-range");
const card = document.getElementById("diagnosis-card");
const cardSummary = document.getElementById("card-summary");
const cardReason = document.getElementById("card-reason");
const cardMeta = document.getElementById("card-meta");
const cardClose = document.getElementById("card-close");
const saveModal = document.getElementById("save-modal");
const saveImg = document.getElementById("save-img");
const saveShare = document.getElementById("save-share");
const saveClose = document.getElementById("save-close");

let lipGL = null;
let segOK = false;
let img = null;
let landmarks = null;
let currentPlan = null;
let currentDiag = null;
let currentReason = "";
let currentStyle = "daily";
let intensity = 0.7;
let compareFrac = 1;
let analyzing = false;
let started = false;
let frame = 0;
let debug = 0;
const DEBUG_LABEL = ["正常", "脸遮罩(红)", "皮肤分割(绿)", "相交(蓝)"];

const STYLE_LABEL = { daily: "日常", commute: "通勤", date: "约会", party: "氛围感" };
const setStatus = (t) => (statusEl.textContent = t);

async function ensureModels() {
  if (lipGL) return;
  setStatus("加载模型中…");
  lipGL = new LipGL(glCanvas);
  await initFaceLandmarker();
  try {
    await initSegmenter();
    segOK = true;
  } catch (e) {
    console.warn("皮肤分割不可用：", e.message);
  }
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = URL.createObjectURL(file);
  });
}

// 照片缩到 512 宽给 AI（省 token）
function imgToDataUrl(im, maxW = 512) {
  const scale = Math.min(1, maxW / im.naturalWidth);
  const w = Math.round(im.naturalWidth * scale);
  const h = Math.round(im.naturalHeight * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(im, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.85);
}

function currentSkin() {
  // 照片路径：ImageSegmenter 在静态图上方向/位置与贴图不一致（分割错位到脖子），
  // 改用可靠的几何脸遮罩（不传皮肤分割）。实时摄像头版不受影响。
  return null;
}

function loop() {
  if (!img) return;
  const ts = performance.now();
  if (segOK && frame % 3 === 0) segment(img, ts); // 静态图，分割少跑些
  frame++;
  const wipe = currentPlan ? compareFrac : 1.0;
  // 照片不镜像（mirror=false）
  lipGL.render(img, landmarks, currentPlan, false, currentSkin(), debug, wipe, intensity);
  requestAnimationFrame(loop);
}

async function onFile(file) {
  if (!file) return;
  try {
    await ensureModels();
    setStatus("读取照片…");
    img = await loadImage(file);
    if (uploadHint) uploadHint.style.display = "none"; // 隐藏提示文字
    lipGL.resize(img.naturalWidth, img.naturalHeight);
    // VIDEO 模式检测器对静态图首帧可能返回空，重试几次
    landmarks = null;
    for (let i = 0; i < 6 && !landmarks; i++) {
      landmarks = detect(img, performance.now() + i * 40);
    }
    if (!landmarks) {
      setStatus("没检测到人脸，请换一张清晰的正面照");
      img = null;
      return;
    }
    if (!started) {
      started = true;
      loop();
    }
    setActiveChip(currentStyle);
    await runAI(currentStyle);
  } catch (e) {
    console.error(e);
    setStatus("照片处理失败：" + e.message);
  }
}

function setActiveChip(style) {
  chips.forEach((b) => b.classList.toggle("active", b.dataset.style === style));
}

async function runAI(style = "daily") {
  if (!img || analyzing) return;
  analyzing = true;
  currentStyle = style;
  setActiveChip(style);
  btnAI.disabled = true;
  chips.forEach((b) => (b.disabled = true));
  setStatus(`AI 化妆师正在出「${STYLE_LABEL[style] || ""}」妆…`);
  try {
    const { plan, source, error } = await analyze(imgToDataUrl(img), style);
    currentPlan = plan.makeup;
    currentDiag = plan.diagnosis || {};
    currentReason = plan.reason || "";
    compareFrac = 1;
    compareRange.value = "100";
    btnSave.disabled = false;
    btnBare.disabled = false;
    showCard(plan, source);
    setStatus(
      source === "ai"
        ? `「${STYLE_LABEL[style]}」妆已上 ✨ 调浓度/拖对比，可保存`
        : `已上妆（本地兜底：${error || ""}）`
    );
  } catch (e) {
    setStatus("分析失败：" + e.message);
  } finally {
    analyzing = false;
    btnAI.disabled = false;
    chips.forEach((b) => (b.disabled = false));
  }
}

function showCard(plan, source) {
  const d = plan.diagnosis || {};
  cardSummary.textContent = d.summary || "";
  cardReason.textContent = plan.reason || "";
  const tone = d.undertone === "warm" ? "暖调" : d.undertone === "cool" ? "冷调" : d.undertone || "—";
  cardMeta.textContent = `肤调 ${tone} · 脸型 ${d.face_shape || "—"} · 来源 ${source === "ai" ? "AI 化妆师" : "本地兜底"}`;
  card.hidden = false;
}

// 保存对比图（左 AI妆 / 右 素颜 + 理由）
function wrapText(c, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const ch of text) {
    if (c.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else line += ch;
  }
  if (line) lines.push(line);
  return lines;
}

function buildComparison() {
  const w = glCanvas.width;
  const h = glCanvas.height;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const o = out.getContext("2d");
  const skin = currentSkin();
  lipGL.render(img, landmarks, currentPlan, false, skin, 0, 1.0, intensity);
  o.drawImage(glCanvas, 0, 0, w / 2, h, 0, 0, w / 2, h);
  lipGL.render(img, landmarks, null, false, skin, 0, 1.0, intensity);
  o.drawImage(glCanvas, w / 2, 0, w / 2, h, w / 2, 0, w / 2, h);
  o.fillStyle = "rgba(255,255,255,0.9)";
  o.fillRect(w / 2 - 2, 0, 4, h);
  o.font = "600 28px sans-serif";
  o.textBaseline = "top";
  o.fillStyle = "rgba(255,255,255,0.95)";
  o.textAlign = "left";
  o.fillText("AI 妆", 20, 20);
  o.textAlign = "right";
  o.fillText("素颜", w - 20, 20);
  const reason = currentReason || (currentDiag && currentDiag.summary) || "";
  if (reason) {
    o.font = "22px sans-serif";
    o.textAlign = "left";
    const lines = wrapText(o, reason, w - 60);
    const lineH = 32;
    const barH = lines.length * lineH + 56;
    o.fillStyle = "rgba(10,10,14,0.72)";
    o.fillRect(0, h - barH, w, barH);
    o.fillStyle = "#e0607e";
    o.font = "600 18px sans-serif";
    o.fillText("AI 化妆师 · 诊断", 30, h - barH + 16);
    o.fillStyle = "#fff";
    o.font = "22px sans-serif";
    lines.forEach((ln, i) => o.fillText(ln, 30, h - barH + 44 + i * lineH));
  }
  return out;
}

function saveComparison() {
  if (!currentPlan) return;
  const out = buildComparison();
  const dataUrl = out.toDataURL("image/jpeg", 0.92);
  saveImg.src = dataUrl;
  saveModal.hidden = false;
  saveShare.onclick = async () => {
    try {
      const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", 0.92));
      const f = new File([blob], "ai-makeup.jpg", { type: "image/jpeg" });
      if (navigator.canShare && navigator.canShare({ files: [f] })) {
        await navigator.share({ files: [f], title: "AI 妆容对比" });
      } else {
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = "ai-makeup.jpg";
        a.click();
      }
    } catch (e) {
      console.warn(e.message);
    }
  };
}

fileInput.addEventListener("change", (e) => onFile(e.target.files[0]));
btnAI.addEventListener("click", () => runAI(currentStyle));
btnBare.addEventListener("click", () => {
  currentPlan = null;
  card.hidden = true;
  setStatus("已切回素颜");
});
btnDebug.addEventListener("click", () => {
  debug = (debug + 1) % 4;
  setStatus(
    `调试：${DEBUG_LABEL[debug]}` +
      (debug === 2 ? "（绿=皮肤分割认定的脸皮；看额头是否为绿）" : "") +
      (debug === 1 ? "（红=几何脸遮罩）" : "")
  );
});
btnSave.addEventListener("click", saveComparison);
chips.forEach((b) => b.addEventListener("click", () => runAI(b.dataset.style)));
intensityRange.addEventListener("input", (e) => (intensity = Number(e.target.value) / 100));
compareRange.addEventListener("input", (e) => (compareFrac = Number(e.target.value) / 100));
cardClose.addEventListener("click", () => (card.hidden = true));
saveClose.addEventListener("click", () => (saveModal.hidden = true));
