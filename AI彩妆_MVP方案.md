# 实时 AI 彩妆 · MVP 可执行方案

> 面向 WAIC 2026 Future Tech「创新赛道（一人公司）」
> 一句话定位：打开摄像头，AI 像化妆师一样判断你适合什么妆，并实时上妆——你什么都不用选。

---

## 一、产品定位与核心卖点

普通试妆产品让用户「自己选色号、选妆容」。本作品的差异点是把审美决策交给 AI：

1. **AI 自动选妆**——用户不挑颜色、不挑风格，AI 分析肤色脸型后直接给出最适合的方案。
2. **AI 实时上妆**——摄像头画面里实时渲染，不是上传照片再出图。
3. **AI 说明理由**——上妆同时给一句诊断（"你是冷调皮肤，莓果色唇 + 冷棕眼影更显白"）。

第 3 点是传播引擎：让"AI 化妆师帮你诊断"变成可截图、可分享的内容，天然契合小红书。
对应比赛的「Prompt 魔法师」赛道——核心竞争力是把化妆师的审美逻辑写成稳定可用的提示词。

---

## 二、技术架构

系统拆成两条独立运行的管线，这是能跑实时的前提：

| 层 | 运行频率 | 干什么 | 用什么 |
|---|---|---|---|
| 实时渲染层 | 每帧（30fps） | 追踪人脸 + 分区上妆 | MediaPipe Face Mesh + Canvas/WebGL |
| AI 审美层 | 异步（偶尔一次） | 分析肤色脸型 → 出妆容方案 | 多模态大模型 API |

两层通过一份「妆容方案 JSON」连接：AI 层产出方案 → 缓存 → 渲染层每帧读取参数上妆。
**关键纪律：绝不每帧调大模型**。方案算一次，存住，重用。

---

## 三、技术选型

| 模块 | 选型 | 理由 / 备选 |
|---|---|---|
| 前端框架 | React + Vite | 轻、快、好分享；备选纯 HTML/JS 或微信小程序 |
| 人脸关键点 | MediaPipe FaceLandmarker（Tasks API） | 478 点、浏览器实时、免费、跨端 |
| 渲染 | MVP 用 Canvas 2D，后期升 WebGL | Canvas 先验证观感，WebGL 做高质量混合 |
| AI 审美分析 | 多模态视觉大模型 API | 看图输出结构化方案；这是"AI 审美"的核心 |
| 后端 | 一个极薄的代理（隐藏 API Key） | Serverless 即可；前端不要直连放密钥 |
| 算力 | 全部走 API，不自建 GPU | 一人公司省成本的关键 |

**为什么不用扩散模型（Stable-Makeup / SHMT）**：效果惊艳但一张几秒，只适合"上传照片"场景，做不了实时。实时只能走"关键点 + 分区上色"。

---

## 四、妆容方案数据结构

AI 层产出、渲染层消费的统一格式。先定好它，两层就能并行开发：

```json
{
  "diagnosis": {
    "undertone": "cool",
    "face_shape": "oval",
    "summary": "冷调皮肤，五官清晰，适合干净通透的伪素颜风"
  },
  "makeup": {
    "lips":    { "color": "#C0506B", "opacity": 0.55, "style": "moist" },
    "blush":   { "color": "#E89AA0", "opacity": 0.30, "position": "apple" },
    "eyeshadow": { "color": "#A87C6B", "opacity": 0.40, "region": "lid" },
    "eyebrow": { "color": "#6B4A3A", "opacity": 0.50 }
  },
  "reason": "你是冷调皮肤，莓果色唇 + 冷棕眼影会更显白、更高级。"
}
```

`reason` 字段直接拿去做"AI 诊断卡"展示给用户。

---

## 五、开发步骤

### 阶段 0 · 跑通底座
- 初始化 React + Vite 工程。
- 接入摄像头（`getUserMedia`），画面渲染到 `<video>` + `<canvas>`。
- 引入 MediaPipe FaceLandmarker，把 478 个关键点画出来确认追踪正常。

```js
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const vision = await FilesetResolver.forVisionTasks(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
);
const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
  baseOptions: { modelAssetPath: "face_landmarker.task" },
  runningMode: "VIDEO",
  numFaces: 1,
});
// 每帧：const result = faceLandmarker.detectForVideo(video, performance.now());
```

### 阶段 1 · 单区域上妆
- 只做**唇色**。用嘴唇相关关键点连成路径，Canvas 填色，叠加混合。
- 目标：先确认"实时贴合 + 自然观感"成不成立——这是 demo 够不够酷的分水岭。
- 调通 alpha 混合 / `multiply` 混合模式，让颜色跟着嘴唇而不是糊一块。

```js
// 伪代码：用嘴唇关键点构成路径并填色
ctx.save();
ctx.beginPath();
LIP_INDICES.forEach((i, n) => {
  const p = landmarks[i];
  const x = p.x * canvas.width, y = p.y * canvas.height;
  n === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
});
ctx.closePath();
ctx.globalAlpha = makeup.lips.opacity;
ctx.globalCompositeOperation = "multiply"; // 让颜色透出皮肤纹理
ctx.fillStyle = makeup.lips.color;
ctx.fill();
ctx.restore();
```

### 阶段 2 · 多区域上妆
- 依次加眼影、腮红、眉毛，每个区域一套关键点 + 一套混合参数。
- 全部从「妆容方案 JSON」读参数，方便后面被 AI 层驱动。

### 阶段 3 · AI 审美层
- 抓当前一帧（`canvas.toDataURL` → base64），通过后端代理发给多模态模型。
- 用提示词约束模型**只返回上面那个 JSON**（见第六节）。
- 解析后存进状态，供渲染层使用。

### 阶段 4 · 串成闭环 + 诊断卡
- 流程：进入 → 实时追踪上妆（默认裸脸）→ 点"AI 帮我上妆" → 出方案 → 自动上妆 + 弹出诊断卡（显示 `reason`）。
- 诊断卡做成好截图的样式（前后对比 + 一句理由），这是传播点。

### 阶段 5 · 打磨与传播
- 上妆前后对比滑块、一键保存对比图、"换一个 AI 推荐妆"。
- 渲染细节打磨（边缘羽化、随光照调整强度）。

---

## 六、AI 审美层的提示词设计

这是「Prompt 魔法师」赛道的发力点。要点：

1. **给模型一个角色**：资深彩妆师 + 色彩顾问。
2. **限定输出**：只输出 JSON，不要任何多余文字（方便解析）。
3. **要求推理依据**：让它基于冷暖肤调、脸型、五官给方案，并写进 `reason`。
4. **约束取值范围**：颜色用 hex，opacity 用 0–1，避免离谱参数。

示例 system 提示（按需调整）：

> 你是资深彩妆师兼色彩顾问。分析图中人物的肤色冷暖、脸型、五官特点，给出最适合的日常妆容。
> 只返回如下结构的 JSON，不要任何解释或代码块标记：{…上面的 schema…}。
> opacity 控制在 0.25–0.6 的自然范围；reason 用一句中文说明为什么这套妆适合 TA。

> 提示：把"审美规则"沉淀进提示词（如冷调配莓果色、圆脸用斜向腮红收缩），输出会更专业稳定，也更像"有审美"。

---

## 七、关键难点与对策

| 难点 | 对策 |
|---|---|
| 实时渲染不自然，像廉价滤镜 | 尽早在阶段 1 验证；用混合模式 + 边缘羽化；强度别拉满 |
| 大模型太慢 / 太贵 | 一次出方案缓存复用，绝不每帧调用 |
| 不同光线下肤色判断会飘 | 提示用户自然光使用；可加简单白平衡校正 |
| 移动端性能 | 控制 numFaces=1、降采样、必要时降帧到 24fps |

