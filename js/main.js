// 应用主流程：串起两层管线。
// 实时渲染层（每帧）：摄像头 → FaceLandmarker(+皮肤分割) → WebGL 渲染(LipGL)
// AI 审美层（异步偶发）：抓帧 → 后端 → 方案 JSON → 缓存复用
//
// 渲染层已迁到 WebGL：相机帧+关键点遮罩+皮肤分割，在 shader 里做
// 粉底/腮红/眼影/眉/口红的混合。前后对比直接在 shader 里按 wipe 左右分。
import { initFaceLandmarker, startCamera, detect } from "./faceTracking.js";
import { captureFrame, analyze } from "./api.js";
import { LipGL } from "./webgl/lipGL.js";
import { initSegmenter, segment, getSkinCanvas, skinReady } from "./webgl/skinSeg.js";

const video = document.getElementById("cam");
const glCanvas = document.getElementById("overlay");

const btnStart = document.getElementById("btn-start");
const btnAI = document.getElementById("btn-ai");
const btnBare = document.getElementById("btn-bare");
const btnSave = document.getElementById("btn-save");
const statusEl = document.getElementById("status");
const styleRow = document.getElementById("style-row");
const chips = Array.from(document.querySelectorAll(".chip"));
const compareWrap = document.getElementById("compare-wrap");
const compareRange = document.getElementById("compare-range");
const intensityWrap = document.getElementById("intensity-wrap");
const intensityRange = document.getElementById("intensity-range");
const card = document.getElementById("diagnosis-card");
const cardSummary = document.getElementById("card-summary");
const cardReason = document.getElementById("card-reason");
const cardMeta = document.getElementById("card-meta");
const cardClose = document.getElementById("card-close");
const saveModal = document.getElementById("save-modal");
const saveImg = document.getElementById("save-img");
const saveShare = document.getElementById("save-share");
const saveClose = document.getElementById("save-close");

const MIRROR = true; // 自拍镜像

let lipGL = null;
let currentPlan = null; // 缓存的妆容方案（绝不每帧重算）
let currentDiag = null;
let currentReason = "";
let lastLandmarks = null;
let running = false;
let analyzing = false;
let compareFrac = 1; // 对比滑块：1=全妆，0=全素颜
let intensity = 0.7; // 全局妆容浓度
let currentStyle = "daily";
let segOK = false; // 皮肤分割是否可用
let frame = 0;
let missFrames = 0; // 连续检测不到人脸的帧数

const STYLE_LABEL = { daily: "日常", commute: "通勤", date: "约会", party: "氛围感" };

const setStatus = (t) => (statusEl.textContent = t);

// 关键点时序平滑（EMA）：减少逐帧抖动，让妆色贴脸不抖
let _smooth = null;
function smoothLandmarks(lm) {
  if (!lm) return _smooth;
  if (!_smooth || _smooth.length !== lm.length) {
    _smooth = lm.map((p) => ({ x: p.x, y: p.y }));
    return _smooth;
  }
  const a = 0.5;
  for (let i = 0; i < lm.length; i++) {
    _smooth[i].x += (lm[i].x - _smooth[i].x) * a;
    _smooth[i].y += (lm[i].y - _smooth[i].y) * a;
  }
  return _smooth;
}

function currentSkin() {
  return segOK && skinReady() ? getSkinCanvas() : null;
}

// 每帧循环
function loop() {
  if (!running) return;
  const ts = performance.now();
  const lm = detect(video, ts);
  // 检测到才更新；连续多帧检测不到（脸离开画面）就清空，妆容不再"飘"在原处
  if (lm) {
    lastLandmarks = smoothLandmarks(lm);
    missFrames = 0;
  } else if (++missFrames > 8) {
    lastLandmarks = null;
    _smooth = null;
  }

  // 皮肤分割：每隔一帧跑一次（省算力）
  if (segOK && frame % 2 === 0) segment(video, ts);
  frame++;

  const wipe = currentPlan ? compareFrac : 1.0;
  lipGL.render(video, lastLandmarks, currentPlan, MIRROR, currentSkin(), 0, wipe, intensity);
  requestAnimationFrame(loop);
}

async function start() {
  btnStart.disabled = true;
  setStatus("加载 AI 模型中…");
  try {
    lipGL = new LipGL(glCanvas);
    await initFaceLandmarker();
    setStatus("加载皮肤分割模型…");
    try {
      await initSegmenter();
      segOK = true;
    } catch (e) {
      console.warn("皮肤分割不可用，粉底回退几何遮罩：", e.message);
    }
    setStatus("请求摄像头…");
    const { width, height } = await startCamera(video);
    lipGL.resize(width, height);
    running = true;
    btnAI.disabled = false;
    btnBare.disabled = false;
    setStatus("追踪中 · 默认裸脸。点「AI 帮我上妆」试试");
    loop();
  } catch (e) {
    console.error(e);
    setStatus("启动失败：" + e.message + "（需 https 或 localhost 才能用摄像头）");
    btnStart.disabled = false;
  }
}

function setActiveChip(style) {
  chips.forEach((c) => c.classList.toggle("active", c.dataset.style === style));
}

async function runAI(style = "daily") {
  if (!running || analyzing) return;
  analyzing = true;
  currentStyle = style;
  setActiveChip(style);
  btnAI.disabled = true;
  chips.forEach((c) => (c.disabled = true));
  setStatus(`AI 化妆师正在出「${STYLE_LABEL[style] || ""}」妆…`);
  try {
    const frameData = captureFrame(video);
    const { plan, source, error } = await analyze(frameData, style);
    currentPlan = plan.makeup;
    currentDiag = plan.diagnosis || {};
    currentReason = plan.reason || "";
    compareFrac = 1;
    compareRange.value = "100";
    compareWrap.hidden = false;
    intensityWrap.hidden = false;
    styleRow.hidden = false;
    btnSave.disabled = false;
    showCard(plan, source);
    setStatus(
      source === "ai"
        ? `「${STYLE_LABEL[style]}」妆已上 ✨ 点风格可切换 · 拖滑块看对比`
        : `已上妆（本地兜底：${error || "AI 不可用"}）`
    );
  } catch (e) {
    console.error(e);
    setStatus("分析失败：" + e.message);
  } finally {
    analyzing = false;
    btnAI.disabled = false;
    chips.forEach((c) => (c.disabled = false));
  }
}

function showBare() {
  currentPlan = null;
  card.hidden = true;
  compareWrap.hidden = true;
  intensityWrap.hidden = true;
  styleRow.hidden = true;
  btnSave.disabled = true;
  currentStyle = "daily";
  setActiveChip("daily");
  setStatus("已切回裸脸");
}

// 诊断卡：好截图的传播点
function showCard(plan, source) {
  const d = plan.diagnosis || {};
  cardSummary.textContent = d.summary || "";
  cardReason.textContent = plan.reason || "";
  const tone = d.undertone === "warm" ? "暖调" : d.undertone === "cool" ? "冷调" : d.undertone || "—";
  cardMeta.textContent = `肤调 ${tone} · 脸型 ${d.face_shape || "—"} · 来源 ${source === "ai" ? "AI 化妆师" : "本地兜底"}`;
  card.hidden = false;
}

// ---- 一键保存对比图（左 AI妆 / 右 素颜 + 理由文案）----
function wrapText(c, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const ch of text) {
    if (c.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
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

  // 左半=AI妆：满妆渲染一帧，拷左半
  lipGL.render(video, lastLandmarks, currentPlan, MIRROR, skin, 0, 1.0);
  o.drawImage(glCanvas, 0, 0, w / 2, h, 0, 0, w / 2, h);
  // 右半=素颜：无妆渲染一帧，拷右半
  lipGL.render(video, lastLandmarks, null, MIRROR, skin, 0, 1.0);
  o.drawImage(glCanvas, w / 2, 0, w / 2, h, w / 2, 0, w / 2, h);

  // 分隔线
  o.fillStyle = "rgba(255,255,255,0.9)";
  o.fillRect(w / 2 - 2, 0, 4, h);
  // 顶部标签
  o.font = "600 28px sans-serif";
  o.textBaseline = "top";
  o.fillStyle = "rgba(255,255,255,0.95)";
  o.textAlign = "left";
  o.fillText("AI 妆", 20, 20);
  o.textAlign = "right";
  o.fillText("素颜", w - 20, 20);
  // 底部理由横幅
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

async function saveComparison() {
  if (!currentPlan) return;
  const out = buildComparison();
  const dataUrl = out.toDataURL("image/jpeg", 0.92);
  saveImg.src = dataUrl;
  saveModal.hidden = false;

  saveShare.onclick = async () => {
    try {
      const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", 0.92));
      const file = new File([blob], "ai-makeup.jpg", { type: "image/jpeg" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "我的 AI 妆容对比" });
      } else {
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = "ai-makeup.jpg";
        a.click();
      }
    } catch (e) {
      console.warn("分享/保存失败：", e.message);
    }
  };
}

btnStart.addEventListener("click", start);
btnAI.addEventListener("click", () => runAI("daily"));
btnBare.addEventListener("click", showBare);
btnSave.addEventListener("click", saveComparison);
chips.forEach((c) => c.addEventListener("click", () => runAI(c.dataset.style)));
compareRange.addEventListener("input", (e) => {
  compareFrac = Number(e.target.value) / 100;
});
intensityRange.addEventListener("input", (e) => {
  intensity = Number(e.target.value) / 100;
});
cardClose.addEventListener("click", () => (card.hidden = true));
saveClose.addEventListener("click", () => (saveModal.hidden = true));
