// WebGL 唇色 demo 控制器：复用现有人脸追踪 + AI 客户端，渲染交给 LipGL。
// 目的：验证 WebGL 唇色观感（质地/羽化/跟随光照），不影响主程序。
import { initFaceLandmarker, startCamera, detect } from "../faceTracking.js";
import { captureFrame, analyze } from "../api.js";
import { LipGL } from "./lipGL.js";
import { initSegmenter, segment, getSkinCanvas, skinReady, getSegInfo } from "./skinSeg.js";

const glCanvas = document.getElementById("gl");
const btnStart = document.getElementById("btn-start");
const btnAI = document.getElementById("btn-ai");
const btnBare = document.getElementById("btn-bare");
const opacity = document.getElementById("opacity");
const colorInput = document.getElementById("color");
const foundation = document.getElementById("foundation");
const fndShade = document.getElementById("fnd-shade");
const finishBtns = Array.from(document.querySelectorAll("[data-finish]"));
const statusEl = document.getElementById("status");

const MIRROR = true;

// 单一妆容对象：手动控件改唇/粉底，「AI 取妆」整套替换（含腮红/眼影/眉）
let makeup = {
  foundation: { shade: "#E8C8AE", coverage: 0.0 }, // 默认不上粉底
  lips: { color: "#C0506B", opacity: 0.5, style: "moist" },
  blush: null,
  eyeshadow: null,
  eyebrow: null,
};
let lipGL = null;
let running = false;
let lastLandmarks = null;
let analyzing = false;
let segOK = false; // 皮肤分割是否可用
let frame = 0;
let debug = 0; // 0=正常 1=脸遮罩 2=皮肤分割 3=相交
const DEBUG_LABEL = ["正常", "脸遮罩(红)", "皮肤分割(绿)", "相交(蓝)"];

const setStatus = (t) => (statusEl.textContent = t);

// 关键点时序平滑（EMA）：减少逐帧抖动，让妆色"贴"在嘴上而不是抖边。
// alpha 越大越跟手但越抖；越小越稳但越滞后。0.5 是平衡点。
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

function syncControls() {
  opacity.value = String(Math.round(makeup.lips.opacity * 100));
  colorInput.value = makeup.lips.color;
  foundation.value = String(Math.round((makeup.foundation?.coverage ?? 0) * 100));
  fndShade.value = makeup.foundation?.shade ?? "#E8C8AE";
  finishBtns.forEach((b) => b.classList.toggle("active", b.dataset.finish === makeup.lips.style));
}

function loop() {
  if (!running) return;
  const lm = detect(glCanvas.__video, performance.now());
  const sm = smoothLandmarks(lm); // 平滑后再用，贴脸不抖
  if (sm) lastLandmarks = sm;

  // 皮肤分割：每隔一帧跑一次（省算力），渲染用最新结果
  const ts = performance.now();
  if (segOK && frame % 2 === 0) segment(glCanvas.__video, ts);
  frame++;
  const skin = segOK && skinReady() ? getSkinCanvas() : null;

  lipGL.render(glCanvas.__video, lastLandmarks, makeup, MIRROR, skin, debug);

  // 调试模式2：实时把分割内部状态打到状态栏
  if (debug === 2 && frame % 15 === 0) {
    setStatus("分割诊断：ready=" + skinReady() + " | " + getSegInfo());
  }
  requestAnimationFrame(loop);
}

async function start() {
  btnStart.disabled = true;
  setStatus("加载模型中…");
  try {
    lipGL = new LipGL(glCanvas);
    await initFaceLandmarker();
    // 皮肤分割（best-effort）：失败则粉底回退几何遮罩
    setStatus("加载皮肤分割模型…");
    try {
      await initSegmenter();
      segOK = true;
    } catch (e) {
      console.warn("皮肤分割不可用，粉底回退几何遮罩：", e.message);
    }
    setStatus("请求摄像头…");
    // 复用 startCamera：需要一个 <video> 元素作帧源。
    // 挂到 DOM（隐藏）以保证 iOS Safari 能正常解码播放。
    const video = document.createElement("video");
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.muted = true;
    video.style.cssText =
      "position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; left:0; top:0;";
    document.body.appendChild(video);
    glCanvas.__video = video;
    const { width, height } = await startCamera(video);
    lipGL.resize(width, height);
    running = true;
    btnAI.disabled = false;
    btnBare.disabled = false;
    syncControls();
    setStatus(
      "已开 · 拉「粉底」看匀肤" +
        (segOK ? "（已用皮肤分割，刘海/眼镜处不上）" : "（皮肤分割未加载，粉底用几何遮罩）")
    );
    loop();
  } catch (e) {
    console.error(e);
    setStatus("启动失败：" + e.message);
    btnStart.disabled = false;
  }
}

async function runAI() {
  if (!running || analyzing) return;
  analyzing = true;
  btnAI.disabled = true;
  setStatus("AI 取妆中…");
  try {
    const { plan, source, error } = await analyze(captureFrame(glCanvas.__video), "daily");
    makeup = { ...plan.makeup }; // 整套妆容（含腮红/眼影/眉）
    if (!makeup.foundation) makeup.foundation = { shade: "#E8C8AE", coverage: 0 };
    syncControls();
    setStatus(
      source === "ai"
        ? `AI 妆已取 · 唇 ${makeup.lips.color} · 粉底 ${makeup.foundation.shade}（拉滑块调粉底浓度）`
        : `本地兜底（${error || ""}）：唇 ${makeup.lips.color}`
    );
  } catch (e) {
    setStatus("失败：" + e.message);
  } finally {
    analyzing = false;
    btnAI.disabled = false;
  }
}

btnStart.addEventListener("click", start);
btnAI.addEventListener("click", runAI);
btnBare.addEventListener("click", () => {
  debug = (debug + 1) % 4;
  setStatus(
    `调试：${DEBUG_LABEL[debug]}` +
      (debug === 2 ? " ← 绿色应覆盖你的脸皮(挖掉眼/唇)；若空白或错位=分割问题" : "") +
      (debug === 3 ? " ← 蓝色=粉底实际生效区域" : "")
  );
});
opacity.addEventListener("input", (e) => (makeup.lips.opacity = Number(e.target.value) / 100));
colorInput.addEventListener("input", (e) => (makeup.lips.color = e.target.value));
foundation.addEventListener("input", (e) => (makeup.foundation.coverage = Number(e.target.value) / 100));
fndShade.addEventListener("input", (e) => (makeup.foundation.shade = e.target.value));
finishBtns.forEach((b) =>
  b.addEventListener("click", () => {
    makeup.lips.style = b.dataset.finish;
    syncControls();
  })
);
