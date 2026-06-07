// 实时渲染层底座：封装 MediaPipe FaceLandmarker。
// 通过 importmap 从 CDN 加载 @mediapipe/tasks-vision（见 index.html）。
import {
  FaceLandmarker,
  FilesetResolver,
} from "@mediapipe/tasks-vision";

let faceLandmarker = null;

// 初始化 FaceLandmarker（VIDEO 模式，单人脸）。
export async function initFaceLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm"
  );
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
  });
  return faceLandmarker;
}

// 请求摄像头并把流接到 <video>。返回实际视频尺寸。
export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return { width: video.videoWidth, height: video.videoHeight };
}

// 对当前帧做检测，返回首张人脸的 478 个关键点（或 null）。
export function detect(video, timestampMs) {
  if (!faceLandmarker) return null;
  const result = faceLandmarker.detectForVideo(video, timestampMs);
  if (result.faceLandmarks && result.faceLandmarks.length > 0) {
    return result.faceLandmarks[0];
  }
  return null;
}
