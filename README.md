# AI 化妆师 · 实时 AI 彩妆

> 打开摄像头或上传照片,AI 像化妆师一样判断你适合什么妆,并实时上妆——**你什么都不用选**。
> WAIC 2026 Future Tech「一人公司 / Prompt 魔法师」赛道参赛作品 · 一人独立开发。

普通试妆产品让用户自己选色号、选妆容。本作品把**审美决策权交给 AI**:
分析肤色冷暖、脸型五官后,**自动**给出一整套最适合你的中式 / 日韩妆容并实时上妆,
还告诉你**为什么**这么配(可截图分享的"AI 诊断卡")。

完整产品/技术方案见 [AI彩妆_MVP方案.md](AI彩妆_MVP方案.md)。

---

## 两个入口

| 页面 | 说明 |
|---|---|
| `/index.html` | **实时摄像头**版:开摄像头 → AI 自动上妆 → 风格切换 / 浓度 / 前后对比 / 保存图 |
| `/photo.html` | **照片试妆**版:上传一张人脸照 → AI 诊断 + 上妆 → 导出"前后对比 + 诊断"图 |

---

## 它怎么工作（两层解耦）

| 层 | 频率 | 干什么 | 技术 |
|---|---|---|---|
| **AI 审美层** | 异步（点一下才调一次） | 分析肤色脸型 → 出整套妆容方案 | Claude 多模态视觉 + 结构化输出（后端代理） |
| **实时渲染层** | 每帧（~30fps） | 追踪人脸 + 分区上妆 | MediaPipe 关键点 + 皮肤分割 + WebGL shader |

两层通过一份「妆容方案 JSON」连接:AI 出方案 → 前端缓存 → 渲染层每帧读参数上妆。
**核心纪律:绝不每帧调大模型**(算一次、缓存、重用)。

```
摄像头/照片 ─▶ MediaPipe 478点 + 皮肤分割 ─▶ WebGL shader 渲染 ─┐  每帧
                                                              ▲
                                                              │ makeup JSON（缓存）
点「AI 上妆」 ─▶ 抓帧 ─▶ 后端代理 ─▶ Claude 多模态 ─────────────┘  偶发一次
```

### 核心竞争力:把化妆师审美写成提示词
AI 审美层用提示词约束模型:**面向亚洲/中国女性,走中式/日韩伪素颜**(显白通透、自然平眉、内敛渐变眼影,**避免欧美 cut-crease/重修容**);把"冷调配莓果唇、圆脸斜扫腮红收脸、暗光不强提高光"等审美规则沉淀进 system 提示;并用**结构化输出**强约束妆容 JSON,保证前端稳定解析。

### 覆盖的妆容部位（11 个,AI 推荐形+色+技法）
粉底 · 遮瑕 · 高光 · 修容 · 眼线 · 美瞳 · 口红 · 腮红 · 眼影 · 眉 ·（整体浓度）。
不只换颜色——AI 还按脸型/风格推荐**形态与技法**:腮红位置(苹果肌/斜扫/卧蚕/晒伤腮)、眼线风格(内眼线/自然/拉长/上扬/下垂)、眼影技法(单色/渐变/下眼影/卧蚕)、口红质地(水光/哑光)、眼影珠光等。

### 渲染层亮点（WebGL）
- **保亮度换色**:口红/美瞳保留原明暗(瞳孔仍黑、唇纹仍在),只换色相,自然不假。
- **粉底真遮盖**:皮肤区域内局部抹匀**盖痘印**,且只作用在皮肤上(挖掉眼/唇/鼻孔)——是粉底遮盖,不是磨皮滤镜。
- **跟随光照**:高光/珠光按皮肤受光度调制,暗处不出现割裂亮斑。
- **皮肤分割**:实时摄像头版用 MediaPipe 分割,妆只落真实皮肤(刘海/眼镜处不上)。

---

## 运行

需要 Python 3.9+（仅标准库做服务器;调真·AI 才需 anthropic SDK）。

### 1) 配置 API Key
在项目根目录 `.env` 填入:
```
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx
```
> 没配 Key 也能跑:会用本地兜底规则化方案演示完整闭环。

### 2) 启动
```bash
pip install -r server/requirements.txt
python server/app.py
```
服务器**默认 HTTPS(自签证书,自动生成)+ 监听 0.0.0.0**,手机同一 Wi-Fi 可访问。
启动后看终端打印的地址:
```
本机访问：    https://localhost:8000
手机/局域网： https://192.168.x.x:8000   ← 手机浏览器打开这个
```
自签证书首次会有安全警告 → 「高级 / 继续访问」即可。端口被占会自动顺延。

可选环境变量:`PORT`(默认 8000)、`AIMAKEUP_MODEL`(默认 `claude-opus-4-8`)、`AIMAKEUP_HTTP=1`(强制纯 http)。

---

## 目录结构

```
index.html / photo.html        实时摄像头版 / 照片试妆版
css/style.css                  样式
js/
  faceTracking.js              MediaPipe FaceLandmarker 封装
  landmarks.js                 人脸/虹膜关键点索引常量
  api.js / mockAI.js           AI 客户端 / 无 Key 时本地兜底
  main.js / photoMain.js       实时版 / 照片版 主流程
  webgl/
    lipGL.js                   WebGL 妆容渲染器（11 部位的 shader + 遮罩层）
    skinSeg.js                 MediaPipe 皮肤分割
server/
  app.py                       极薄后端:静态服务 + /api/analyze 代理（隐藏 Key）+ 自签证书 + .env 加载
  test_backend.py              离屏管道测试（无需真 Key）
  requirements.txt
```

## 妆容方案 JSON

后端用 Claude 的**结构化输出**(`output_config.format` + JSON Schema)强约束,前端稳定解析。示例(节选):
```json
{
  "diagnosis": { "undertone": "cool", "face_shape": "oval", "summary": "…" },
  "makeup": {
    "foundation": { "shade": "#E8C9B0", "coverage": 0.35 },
    "lips":       { "color": "#C0506B", "opacity": 0.45, "style": "moist" },
    "blush":      { "color": "#E89AA0", "opacity": 0.30, "placement": "diagonal" },
    "eyeshadow":  { "color": "#A87C6B", "opacity": 0.35, "finish": "shimmer", "technique": "gradient" },
    "eyeliner":   { "color": "#3A2A22", "opacity": 0.5, "style": "natural" },
    "lens":       { "color": "#4A3328", "opacity": 0.32 },
    "...": "concealer / highlighter / contour / eyebrow"
  },
  "reason": "你是冷调皮肤,莓果色唇 + 冷棕眼影会更显白更高级。"
}
```

## 现状与路线

- **已成立**:AI 自动诊断+选妆(中式/日韩)、实时上妆、11 部位、风格切换、粉底遮瑕、前后对比+诊断卡分享。
- **后续方向**:学习式渲染;用化妆师标注数据微调垂直审美模型;接真实品牌色卡,AI 推荐"可买的同色号"。

