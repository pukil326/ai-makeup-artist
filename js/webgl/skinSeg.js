// 逐像素皮肤分割：MediaPipe Selfie Multiclass。
// 把画面分成 背景/头发/身体皮肤/面部皮肤/衣服/配件，取「面部皮肤」类做掩码。
// 与几何遮罩相交后，妆只落在真实露出的皮肤上（刘海/头发/眼镜处自动不上）。
import { ImageSegmenter, FilesetResolver } from "@mediapipe/tasks-vision";

// 实测该模型类别：0 背景 1 身体皮肤(脖子) 2 面部皮肤 3 衣服 4 配件(眼镜)…
// （与官方文档顺序不同，以真机假彩色诊断为准）面部皮肤 = 类别 2。
const FACE_SKIN = 2;

let segmenter = null;
let _ready = false;
let _info = "未运行"; // 屏上诊断

// 皮肤掩码画布（白=面部皮肤），尺寸随分割结果（=视频分辨率）动态调整
const skinCanvas = document.createElement("canvas");
const skinCtx = skinCanvas.getContext("2d", { willReadFrequently: true });
const tmp = document.createElement("canvas");
const tmpCtx = tmp.getContext("2d");

export async function initSegmenter() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm"
  );
  segmenter = await ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });
}

function onResult(result) {
  const m = result && result.categoryMask;
  if (!m) {
    _info = "回调触发但无 categoryMask（result keys: " +
      (result ? Object.keys(result).join(",") : "null") + "）";
    return;
  }
  // 掩码尺寸 = 输入视频分辨率（MediaPipe 会上采样），必须按真实宽高读
  const w = m.width;
  const h = m.height;
  const cat = m.getAsUint8Array(); // 长度 = w*h，每个值=类别索引
  m.close();
  // 统计各类别像素数（抽样），看模型到底输出了什么、面部皮肤是哪个索引
  const counts = {};
  const step = Math.max(1, Math.floor(cat.length / 20000));
  for (let i = 0; i < cat.length; i += step) counts[cat[i]] = (counts[cat[i]] || 0) + 1;
  _info = `mask ${w}x${h} len ${cat.length} | 类别抽样 ${JSON.stringify(counts)}`;

  if (!w || !h || cat.length < w * h) {
    _ready = true;
    return;
  }
  if (skinCanvas.width !== w || skinCanvas.height !== h) {
    skinCanvas.width = w;
    skinCanvas.height = h;
    tmp.width = w;
    tmp.height = h;
  }
  // 二值面部皮肤掩码：面部皮肤=白，其余=黑
  const img = skinCtx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = cat[i] === FACE_SKIN ? 255 : 0;
    const j = i * 4;
    img.data[j] = v;
    img.data[j + 1] = v;
    img.data[j + 2] = v;
    img.data[j + 3] = 255;
  }
  skinCtx.putImageData(img, 0, 0);

  // 边缘羽化，过渡自然（putImageData 不吃 filter，借临时画布）
  tmpCtx.clearRect(0, 0, w, h);
  tmpCtx.filter = `blur(${Math.max(2, w * 0.004)}px)`;
  tmpCtx.drawImage(skinCanvas, 0, 0);
  tmpCtx.filter = "none";
  skinCtx.clearRect(0, 0, w, h);
  skinCtx.drawImage(tmp, 0, 0);
  _ready = true;
}

// 对当前帧做分割（VIDEO 模式，时间戳需递增）
export function segment(video, ts) {
  if (!segmenter) {
    _info = "segmenter 为 null";
    return;
  }
  try {
    segmenter.segmentForVideo(video, ts, onResult);
  } catch (e) {
    _info = "segmentForVideo 抛错: " + (e && e.message);
  }
}

export function getSkinCanvas() {
  return skinCanvas;
}
export function skinReady() {
  return _ready;
}
export function getSegInfo() {
  return _info;
}
