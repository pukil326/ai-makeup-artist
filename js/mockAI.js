// 兜底「假 AI」：后端没有 API Key 时也能演示闭环。
// 基于一帧画面的平均肤色做最朴素的冷暖判断，给一套规则化方案。
// 真·AI 审美在后端（server/app.py）。

const COOL = {
  diagnosis: {
    undertone: "cool",
    face_shape: "oval",
    summary: "冷调皮肤，适合干净通透的莓果系伪素颜（本地兜底方案）",
  },
  makeup: {
    foundation: { shade: "#E6C7AE", coverage: 0.32 },
    concealer: { shade: "#F2DBC8", coverage: 0.35 },
    highlighter: { color: "#FBEFE2", opacity: 0.3 },
    contour: { color: "#9C7A66", opacity: 0.18 },
    eyeliner: { color: "#3A2A22", opacity: 0.5, style: "natural" },
    lens: { color: "#4A3328", opacity: 0.32 },
    lips: { color: "#C0506B", opacity: 0.55, style: "moist" },
    blush: { color: "#E89AA0", opacity: 0.3, placement: "diagonal" },
    eyeshadow: { color: "#A87C6B", opacity: 0.4, finish: "matte", technique: "wash" },
    eyebrow: { color: "#6B4A3A", opacity: 0.5 },
  },
  reason: "你偏冷调，莓果色唇 + 冷棕眼影会更显白、更高级。（本地兜底，配置 API Key 后由 AI 生成）",
};

const WARM = {
  diagnosis: {
    undertone: "warm",
    face_shape: "oval",
    summary: "暖调皮肤，适合奶杏/珊瑚系暖光妆（本地兜底方案）",
  },
  makeup: {
    foundation: { shade: "#EBCBA8", coverage: 0.32 },
    concealer: { shade: "#F5DEC9", coverage: 0.35 },
    highlighter: { color: "#FCEFDD", opacity: 0.3 },
    contour: { color: "#A07A5E", opacity: 0.18 },
    eyeliner: { color: "#3E2C20", opacity: 0.5, style: "droopy" },
    lens: { color: "#6B4A30", opacity: 0.4 },
    lips: { color: "#D2705A", opacity: 0.55, style: "moist" },
    blush: { color: "#F0A878", opacity: 0.3, placement: "aegyo" },
    eyeshadow: { color: "#C08A5E", opacity: 0.4, finish: "shimmer", technique: "gradient" },
    eyebrow: { color: "#7A5236", opacity: 0.5 },
  },
  reason: "你偏暖调，珊瑚/奶杏色更衬肤色，整体更显气色。（本地兜底，配置 API Key 后由 AI 生成）",
};

// 各风格的浓淡/质地调整（让兜底也能体现"换风格"差异）
const STYLE_ADJUST = {
  daily: { mul: 1.0, lip: "moist", tag: "日常" },
  commute: { mul: 0.8, lip: "matte", tag: "通勤" },
  date: { mul: 1.15, lip: "moist", tag: "约会" },
  party: { mul: 1.4, lip: "moist", tag: "氛围感" },
};

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// 从 dataURL 估计画面平均色相，粗判冷暖；再按风格调浓淡。
export async function mockAnalyze(dataUrl, style = "daily") {
  const undertone = await guessUndertone(dataUrl);
  const base = undertone === "warm" ? WARM : COOL;
  const adj = STYLE_ADJUST[style] || STYLE_ADJUST.daily;

  // 深拷贝后按风格调整，避免污染常量
  const plan = JSON.parse(JSON.stringify(base));
  for (const part of ["lips", "blush", "eyeshadow", "eyebrow"]) {
    plan.makeup[part].opacity = +clamp(plan.makeup[part].opacity * adj.mul, 0.18, 0.7).toFixed(2);
  }
  plan.makeup.lips.style = adj.lip;
  plan.diagnosis.summary = `${adj.tag}风格 · ${plan.diagnosis.summary}`;
  plan.reason = `【${adj.tag}】` + plan.reason;
  return plan;
}

function guessUndertone(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 64;
      const cx = c.getContext("2d");
      cx.drawImage(img, 0, 0, 64, 64);
      const { data } = cx.getImageData(0, 0, 64, 64);
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
      r /= n;
      g /= n;
      b /= n;
      // 红多于蓝 → 偏暖；反之偏冷
      resolve(r - b > 8 ? "warm" : "cool");
    };
    img.onerror = () => resolve("cool");
    img.src = dataUrl;
  });
}
