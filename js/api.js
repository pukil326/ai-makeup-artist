// AI 审美层客户端：把一帧画面发给后端代理，拿回「妆容方案 JSON」。
// 后端隐藏 API Key；前端永远不直连大模型、不放密钥。
import { mockAnalyze } from "./mockAI.js";

// 抓取 video 当前帧为 base64 dataURL（压到 512 宽，省带宽/token）。
export function captureFrame(video, maxW = 512) {
  const scale = maxW / video.videoWidth;
  const w = maxW;
  const h = Math.round(video.videoHeight * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(video, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.85);
}

// 调后端 /api/analyze。失败（无 Key / 网络）时回退到本地兜底。
export async function analyze(dataUrl, style = "daily") {
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl, style }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return { plan: data, source: "ai" };
  } catch (e) {
    console.warn("AI 后端不可用，回退本地兜底：", e.message);
    const plan = await mockAnalyze(dataUrl, style);
    return { plan, source: "mock", error: e.message };
  }
}
