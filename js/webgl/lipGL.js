// WebGL2 妆容渲染器（嘴唇 + 粉底）。
// 一个全屏 pass，两张遮罩：脸皮遮罩(粉底) + 唇形遮罩(口红)。
// 粉底：在脸皮区域(挖掉眼/唇)做"匀肤 + 轻覆盖"，把肤色推向 AI 给的粉底色号
//       —— 用化妆品而非滤镜磨皮：保留结构，只均匀肤色、淡化泛红/瑕疵。
// 口红：保留唇部明暗的换色 + 水光。
// 重活（逐像素采样/混合/小范围模糊）都在 GPU。遮罩路径用 Canvas2D 画(便宜)。
import {
  LIPS_OUTER, LIPS_INNER, FACE_OVAL, RIGHT_EYE, LEFT_EYE,
  RIGHT_CHEEK, LEFT_CHEEK, RIGHT_EYEBROW, LEFT_EYEBROW,
  RIGHT_EYE_UPPER, LEFT_EYE_UPPER, NOSE_BRIDGE, CUPID,
  FACE_LEFT, FACE_RIGHT, RIGHT_IRIS, LEFT_IRIS,
} from "../landmarks.js";

const VERT = `#version 300 es
in vec2 pos;
out vec2 vUv;
void main() {
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uCam;
uniform sampler2D uLipMask;
uniform sampler2D uFaceMask;
uniform sampler2D uSkin;    // 逐像素皮肤分割掩码（真实露出的面部皮肤）
uniform sampler2D uOverlay; // 腮红/眉/修容/眼线的预合成色层（multiply）
uniform sampler2D uBright;  // 遮瑕/高光提亮层（RGBA，screen 提亮）
uniform sampler2D uEye;     // 眼影独立层（RGBA：颜色 + a=强度）
uniform sampler2D uIris;    // 美瞳层（RGBA：虹膜色 + a=强度，已裁在眼开口内）
uniform float uEyeShimmer;  // 眼影珠光强度（0=哑光）
uniform vec3 uLip;
uniform float uLipOpacity;
uniform float uLipMatte;    // 哑光：压掉唇面偏白高光 → 天鹅绒
uniform float uLipSheen;    // 缎光/水光：亮处加高光的强度
uniform float uSheenLo;     // 缎光起始亮度阈值（越高越聚焦）
uniform vec3 uFnd;          // 粉底色号 0..1
uniform float uFndCov;      // 粉底强度 0..1（0=不上粉底）
uniform vec2 uTexel;        // 1/分辨率（遮盖用局部采样）
uniform float uFndRadius;   // 遮盖采样半径(像素)
uniform float uUseSkin;     // 1=用皮肤分割与几何遮罩相交
uniform float uDebug;       // 0=正常 1=脸遮罩(红) 2=皮肤分割(绿) 3=相交(蓝)
uniform float uWipe;        // 前后对比：vUv.x<uWipe 显示上妆，否则显示素颜(原相机)；1=全妆
uniform float uIntensity;   // 全局妆容浓度：把上妆结果整体混回素颜，0=素颜 1=满妆
uniform float uMirror;
out vec4 frag;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 camUv = vec2(mix(vUv.x, 1.0 - vUv.x, uMirror), vUv.y);
  vec3 skin = texture(uCam, camUv).rgb;
  float faceM = texture(uFaceMask, vUv).a;   // 几何脸遮罩
  float skinM = texture(uSkin, camUv).r;      // 皮肤分割
  float lipM = texture(uLipMask, vUv).a;      // 唇遮罩

  // ---- 调试可视化：把遮罩画出来定位问题 ----
  if (uDebug > 0.5) {
    if (uDebug < 1.5) {                                       // 1: 脸遮罩=红
      frag = vec4(clamp(skin * 0.35 + vec3(faceM, 0.0, 0.0), 0.0, 1.0), 1.0);
    } else if (uDebug < 2.5) {                                // 2: 分割假彩色（按类别）
      vec3 segRGB = texture(uSkin, camUv).rgb;
      frag = vec4(mix(skin * 0.3, segRGB, 0.85), 1.0);
    } else {                                                  // 3: 相交=蓝
      frag = vec4(clamp(skin * 0.35 + vec3(0.0, 0.0, faceM * skinM), 0.0, 1.0), 1.0);
    }
    return;
  }

  vec3 base = skin;

  // ---- 粉底：打底。几何遮罩 × 皮肤分割，只落真实皮肤 ----
  float skinHere = smoothstep(0.0, 1.0, faceM);
  if (uUseSkin > 0.5) skinHere *= skinM;
  float faceCov = skinHere * uFndCov;
  if (skinHere > 0.001 && uFndCov > 0.001) {
    // 1) 遮盖力：与皮肤局部均值混合（双环 18 点模糊，能盖住痘印）。仅皮肤分割内 → 不糊五官
    vec2 o = uTexel * uFndRadius;
    vec2 o2 = o * 2.0;
    vec3 sm = skin * 2.0;
    sm += texture(uCam, camUv + vec2(o.x, 0.0)).rgb + texture(uCam, camUv - vec2(o.x, 0.0)).rgb;
    sm += texture(uCam, camUv + vec2(0.0, o.y)).rgb + texture(uCam, camUv - vec2(0.0, o.y)).rgb;
    sm += texture(uCam, camUv + o).rgb + texture(uCam, camUv - o).rgb;
    sm += texture(uCam, camUv + vec2(o.x, -o.y)).rgb + texture(uCam, camUv + vec2(-o.x, o.y)).rgb;
    sm += texture(uCam, camUv + vec2(o2.x, 0.0)).rgb + texture(uCam, camUv - vec2(o2.x, 0.0)).rgb;
    sm += texture(uCam, camUv + vec2(0.0, o2.y)).rgb + texture(uCam, camUv - vec2(0.0, o2.y)).rgb;
    sm += texture(uCam, camUv + o2).rgb + texture(uCam, camUv - o2).rgb;
    sm += texture(uCam, camUv + vec2(o2.x, -o2.y)).rgb + texture(uCam, camUv + vec2(-o2.x, o2.y)).rgb;
    sm /= 18.0;
    float coverAmt = skinHere * min(0.9, uFndCov * 2.8); // 遮盖随 coverage（比匀肤更强）
    base = mix(base, sm, coverAmt);
    // 2) 匀肤色：色度向粉底靠（严格保留亮度=绝不压暗）
    float Ls = luma(base);
    float Lf = luma(uFnd);
    vec3 toned = clamp(Ls + mix(base - Ls, uFnd - Lf, 0.6), 0.0, 1.0);
    base = mix(base, toned, faceCov);
    // 3) 显白：中高亮区淡淡提亮（亚洲粉底偏显白通透，只升不降）
    float bright = smoothstep(0.5, 1.0, luma(base)) * 0.10 * faceCov;
    base = mix(base, vec3(1.0), bright);
  }

  // ---- 遮瑕 + 高光：screen 提亮，但按皮肤受光度调制 ----
  // 高光是"反光"：暗处本就无光可反 → 暗光时几乎不提亮，避免亮斑浮在暗脸上割裂
  vec4 br = texture(uBright, vUv);
  float lit = smoothstep(0.10, 0.55, luma(skin));
  base = 1.0 - (1.0 - base) * (1.0 - br.rgb * br.a * lit);

  // ---- 眼影：换色 multiply + 珠光闪粉（日韩感）----
  vec4 eye = texture(uEye, vUv);
  if (eye.a > 0.001) {
    base *= mix(vec3(1.0), eye.rgb, eye.a);
    if (uEyeShimmer > 0.001) {
      // 细密珠光颗粒：随机亮斑 × 皮肤受光度（暗处不闪，避免割裂）
      float sp = smoothstep(0.82, 1.0, hash(floor(vUv * 1300.0)));
      base += sp * smoothstep(0.12, 0.7, luma(skin)) * uEyeShimmer * eye.a;
    }
  }

  // ---- 美瞳：虹膜上色 + 放大限制环（瞳孔在贴图里留透明、眨眼已裁剪）----
  vec4 ir = texture(uIris, vUv);
  base = mix(base, ir.rgb, ir.a);

  // ---- 腮红/眉/修容/眼线：预合成色层，multiply 叠在打好底的皮肤上 ----
  vec4 ov = texture(uOverlay, vUv);
  base *= mix(vec3(1.0), ov.rgb, ov.a);

  // ---- 口红：换色 + 质地（哑光天鹅绒 / 缎光水润）----
  float lipCov = smoothstep(0.0, 1.0, lipM);
  if (lipCov > 0.001) {
    float Ll = luma(uLip);
    float Ls = luma(base);
    vec3 recolor = clamp(uLip * (Ls / max(Ll, 0.001)), 0.0, 1.0);
    base = mix(base, recolor, uLipOpacity * lipCov);
    // 哑光：把唇面自身偏白的高光压回唇色 → 天鹅绒质感（matte 口红会吃掉光泽）
    float Lb = luma(base);
    float shine = smoothstep(0.72, 1.0, Lb);
    vec3 matteCol = clamp(uLip * (Lb / max(Ll, 0.001)), 0.0, 1.0);
    base = mix(base, matteCol, uLipMatte * shine * lipCov);
    // 缎光/水光：在唇峰/下唇凸起等亮处加一层柔和高光（不是全唇刷白）
    float sheen = smoothstep(uSheenLo, 1.0, luma(base)) * uLipSheen * lipCov;
    base = mix(base, vec3(1.0), sheen);
  }

  // 全局妆容浓度：把整张妆容效果按浓度混回素颜（一键控浓淡）
  base = mix(skin, base, uIntensity);

  // 前后对比：左侧上妆，右侧素颜(原相机)，中间一条白线
  vec3 outc = (vUv.x < uWipe) ? base : skin;
  if (uWipe > 0.001 && uWipe < 0.999 && abs(vUv.x - uWipe) < 0.0022) outc = vec3(1.0);
  frag = vec4(outc, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("shader 编译失败: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function hexToRgb01(hex) {
  const m = hex.replace("#", "");
  const n = parseInt(
    m.length === 3 ? m.split("").map((c) => c + c).join("") : m,
    16
  );
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class LipGL {
  constructor(glCanvas) {
    const gl = glCanvas.getContext("webgl2", {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // 保存对比图需从 GL canvas 读像素
    });
    if (!gl) throw new Error("此浏览器不支持 WebGL2");
    this.gl = gl;
    this.canvas = glCanvas;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("program 链接失败: " + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    const U = (n) => gl.getUniformLocation(prog, n);
    this.u = {
      cam: U("uCam"), lipMask: U("uLipMask"), faceMask: U("uFaceMask"),
      skin: U("uSkin"), overlay: U("uOverlay"), lip: U("uLip"),
      lipOpacity: U("uLipOpacity"), lipMatte: U("uLipMatte"),
      lipSheen: U("uLipSheen"), sheenLo: U("uSheenLo"), fnd: U("uFnd"),
      fndCov: U("uFndCov"), useSkin: U("uUseSkin"), debug: U("uDebug"),
      wipe: U("uWipe"), mirror: U("uMirror"), intensity: U("uIntensity"),
      eye: U("uEye"), eyeShimmer: U("uEyeShimmer"), bright: U("uBright"),
      iris: U("uIris"), texel: U("uTexel"), fndRadius: U("uFndRadius"),
    };

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.camTex = this._tex();
    this.lipMaskTex = this._tex();
    this.faceMaskTex = this._tex();
    this.skinTex = this._tex();
    this.overlayTex = this._tex();
    this.eyeTex = this._tex();
    this.brightTex = this._tex();
    this.irisTex = this._tex();

    this.lipMaskCanvas = document.createElement("canvas");
    this.lipMaskCtx = this.lipMaskCanvas.getContext("2d");
    this.faceMaskCanvas = document.createElement("canvas");
    this.faceMaskCtx = this.faceMaskCanvas.getContext("2d");
    this.overlayCanvas = document.createElement("canvas");
    this.overlayCtx = this.overlayCanvas.getContext("2d");
    this.eyeCanvas = document.createElement("canvas");
    this.eyeCtx = this.eyeCanvas.getContext("2d");
    this.brightCanvas = document.createElement("canvas");
    this.brightCtx = this.brightCanvas.getContext("2d");
    this.irisCanvas = document.createElement("canvas");
    this.irisCtx = this.irisCanvas.getContext("2d");

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  _tex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    for (const c of [this.lipMaskCanvas, this.faceMaskCanvas, this.overlayCanvas, this.eyeCanvas, this.brightCanvas, this.irisCanvas]) {
      c.width = w;
      c.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  _px(landmarks, i, w, h, mirror) {
    return [
      mirror ? (1 - landmarks[i].x) * w : landmarks[i].x * w,
      landmarks[i].y * h,
    ];
  }

  _faceWidth(landmarks, w, h, mirror) {
    const [lx, ly] = this._px(landmarks, 234, w, h, mirror);
    const [rx, ry] = this._px(landmarks, 454, w, h, mirror);
    return Math.hypot(lx - rx, ly - ry);
  }

  _polyPath(c, landmarks, indices, w, h, mirror) {
    indices.forEach((i, n) => {
      const [x, y] = this._px(landmarks, i, w, h, mirror);
      n === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    });
    c.closePath();
  }

  // 唇形遮罩（外减内，evenodd 挖空口腔），白色=唇区，带羽化与内缩
  _drawLipMask(landmarks, w, h, mirror) {
    const c = this.lipMaskCtx;
    c.clearRect(0, 0, w, h);
    if (!landmarks) return;
    const fw = this._faceWidth(landmarks, w, h, mirror);
    const blur = Math.max(2, fw * 0.014);
    const shrink = 0.06;
    let sx = 0, sy = 0;
    for (const i of LIPS_OUTER) {
      const [x, y] = this._px(landmarks, i, w, h, mirror);
      sx += x; sy += y;
    }
    const cx = sx / LIPS_OUTER.length, cy = sy / LIPS_OUTER.length;
    c.save();
    c.filter = `blur(${blur}px)`;
    c.fillStyle = "#fff";
    c.beginPath();
    LIPS_OUTER.forEach((i, n) => {
      let [x, y] = this._px(landmarks, i, w, h, mirror);
      x += (cx - x) * shrink; y += (cy - y) * shrink;
      n === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    });
    c.closePath();
    this._polyPath(c, landmarks, LIPS_INNER, w, h, mirror);
    c.fill("evenodd");
    c.restore();
  }

  // 脸皮遮罩：脸型轮廓填白，挖掉双眼与嘴唇，整体羽化
  _drawFaceMask(landmarks, w, h, mirror) {
    const c = this.faceMaskCtx;
    c.clearRect(0, 0, w, h);
    if (!landmarks) return;
    const fw = this._faceWidth(landmarks, w, h, mirror);
    const [, browY] = this._px(landmarks, 9, w, h, mirror); // 眉间 y，额头基准
    c.save();
    c.filter = `blur(${Math.max(2, fw * 0.012)}px)`; // 羽化收一点，覆盖更满
    // 1) 脸型填白（额头点往上延伸到发际线，盖住整片额头）
    c.fillStyle = "#fff";
    c.beginPath();
    FACE_OVAL.forEach((idx, n) => {
      let [x, y] = this._px(landmarks, idx, w, h, mirror);
      if (y < browY) y = browY - (browY - y) * 1.38; // 额头(眉以上)上抬，延伸到发际线
      n === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    });
    c.closePath();
    c.fill();
    // 2) 挖掉眼睛、嘴唇（destination-out）
    c.globalCompositeOperation = "destination-out";
    c.fillStyle = "#fff";
    for (const eye of [LEFT_EYE, RIGHT_EYE]) {
      const [ix, iy] = this._px(landmarks, eye.inner, w, h, mirror);
      const [ox, oy] = this._px(landmarks, eye.outer, w, h, mirror);
      const ex = (ix + ox) / 2, ey = (iy + oy) / 2;
      const r = Math.hypot(ix - ox, iy - oy);
      c.beginPath();
      c.ellipse(ex, ey, r * 0.75, r * 0.55, 0, 0, Math.PI * 2);
      c.fill();
    }
    // 鼻孔：挖掉，避免遮盖模糊把鼻孔糊平
    const [rax, ray] = this._px(landmarks, 98, w, h, mirror);
    const [lax, lay] = this._px(landmarks, 327, w, h, mirror);
    const nw = Math.hypot(rax - lax, ray - lay);
    c.beginPath();
    c.ellipse((rax + lax) / 2, (ray + lay) / 2, nw * 0.62, nw * 0.42, 0, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    this._polyPath(c, landmarks, LIPS_OUTER, w, h, mirror);
    c.fill();
    c.restore();
  }

  // 眼影独立层（RGBA：颜色 + alpha=强度），便于 shader 单独加珠光
  _drawEye(landmarks, plan, w, h, mirror) {
    const c = this.eyeCtx;
    c.clearRect(0, 0, w, h);
    if (!landmarks) return;
    const eyeshadow = plan.eyeshadow;
    if (!eyeshadow) return;
    const tech = eyeshadow.technique || "wash";
    const col = eyeshadow.color;
    const op = eyeshadow.opacity ?? 0.4;
    for (const eye of [LEFT_EYE, RIGHT_EYE]) {
      const [ix, iy] = this._px(landmarks, eye.inner, w, h, mirror);
      const [ox, oy] = this._px(landmarks, eye.outer, w, h, mirror);
      const [tx, ty] = this._px(landmarks, eye.top, w, h, mirror);
      const [bx, by] = this._px(landmarks, eye.bottom, w, h, mirror);
      const eyeW = Math.hypot(ix - ox, iy - oy);
      const cx = (ix + ox) / 2;
      const lidY = ty - eyeW * 0.12; // 眼睑上方
      // 基础眼睑晕染（收小，避免晕到太阳穴）
      this._radial(c, cx, lidY, eyeW * 0.6, eyeW * 0.42, col, op * (tech === "aegyo" ? 0.6 : 1));
      // 渐变：睫毛根更深一层
      if (tech === "gradient") {
        this._radial(c, cx, ty - eyeW * 0.04, eyeW * 0.62, eyeW * 0.28, col, op * 0.9);
      }
      // 下眼影 / 卧蚕：眼下一层
      if (tech === "lower" || tech === "aegyo") {
        this._radial(c, cx, by + eyeW * 0.14, eyeW * 0.5, eyeW * 0.22, col, op * (tech === "aegyo" ? 0.5 : 0.55));
      }
    }
  }

  // 腮红/眉的预合成色层（RGBA：颜色 + alpha=强度），shader 里 multiply
  _drawOverlay(landmarks, plan, w, h, mirror) {
    const c = this.overlayCtx;
    c.clearRect(0, 0, w, h);
    if (!landmarks) return;
    const fw = this._faceWidth(landmarks, w, h, mirror);

    // 腮红：按 placement 决定位置/角度
    const blush = plan.blush;
    if (blush) {
      const place = blush.placement || "apple";
      const op = blush.opacity ?? 0.3;
      const col = blush.color;
      const cxC = w / 2;
      for (const ch of [RIGHT_CHEEK, LEFT_CHEEK]) {
        const [bx, by] = this._px(landmarks, ch, w, h, mirror);
        const out = bx < cxC ? -1 : 1; // 朝颞侧（外）
        if (place === "diagonal") {
          // 斜扫：在颧骨上沿向耳侧轻扫（不要爬到太阳穴），收脸显瘦
          this._radial(c, bx + out * fw * 0.02, by + fw * 0.01, fw * 0.13, fw * 0.07, col, op, out * 0.32);
        } else if (place === "aegyo") {
          // 卧蚕下：小、靠近眼下，无辜减龄
          this._radial(c, bx, by - fw * 0.06, fw * 0.09, fw * 0.05, col, op);
        } else if (place === "sunburn") {
          // 晒伤腮：横扫、偏上靠鼻侧
          this._radial(c, bx, by - fw * 0.04, fw * 0.13, fw * 0.06, col, op * 0.9);
        } else {
          // apple 苹果肌
          this._radial(c, bx, by, fw * 0.12, fw * 0.12, col, op);
        }
      }
      if (place === "sunburn") {
        const [nx, ny] = this._px(landmarks, 195, w, h, mirror); // 鼻梁中
        this._radial(c, nx, ny, fw * 0.1, fw * 0.05, col, op * 0.6);
      }
    }
    // 修容：两颊外侧朝中心内移一点轻压暗（收脸，圆脸尤其有效）
    const contour = plan.contour;
    if (contour) {
      const a = contour.opacity ?? 0.18;
      for (const side of [FACE_LEFT, FACE_RIGHT]) {
        const [sx, sy] = this._px(landmarks, side, w, h, mirror);
        const px = sx + (w / 2 - sx) * 0.16; // 朝脸中心内移
        const py = sy + fw * 0.04;
        this._radial(c, px, py, fw * 0.11, fw * 0.18, contour.color, a);
      }
    }
    // 眉毛：柔边填充（软化"色块感"）。形状重塑留待后续 shape 参数化
    const eyebrow = plan.eyebrow;
    if (eyebrow) {
      c.save();
      c.filter = `blur(${Math.max(1, fw * 0.005)}px)`; // 软化边缘，去掉死板色块感
      c.globalAlpha = (eyebrow.opacity ?? 0.5) * 0.5;
      c.fillStyle = eyebrow.color;
      for (const brow of [RIGHT_EYEBROW, LEFT_EYEBROW]) {
        c.beginPath();
        this._polyPath(c, landmarks, brow, w, h, mirror);
        c.fill();
      }
      c.restore();
    }
    // 眼线：按 style 决定粗细 taper 与尾巴方向
    const eyeliner = plan.eyeliner;
    if (eyeliner) {
      const ST = {
        inner: { base: 0.0015, grow: 0.003, wing: 0.0, up: 0.0 },
        natural: { base: 0.002, grow: 0.007, wing: 0.018, up: 0.009 },
        elongated: { base: 0.002, grow: 0.008, wing: 0.045, up: 0.01 },
        winged: { base: 0.0025, grow: 0.011, wing: 0.04, up: 0.022 },
        droopy: { base: 0.002, grow: 0.008, wing: 0.032, up: -0.01 },
      };
      const s = ST[eyeliner.style] || ST.natural;
      c.save();
      c.filter = `blur(${Math.max(0.6, fw * 0.0025)}px)`;
      c.globalAlpha = eyeliner.opacity ?? 0.5;
      c.fillStyle = eyeliner.color;
      for (const lid of [RIGHT_EYE_UPPER, LEFT_EYE_UPPER]) {
        const pts = lid.map((idx) => this._px(landmarks, idx, w, h, mirror));
        const n = pts.length;
        const top = pts.map(([x, y], i) => {
          const t = i / (n - 1);
          return [x, y - fw * (s.base + s.grow * t)];
        });
        c.beginPath();
        pts.forEach(([x, y], i) => (i === 0 ? c.moveTo(x, y) : c.lineTo(x, y)));
        for (let i = n - 1; i >= 0; i--) c.lineTo(top[i][0], top[i][1]);
        c.closePath();
        c.fill();
        // 尾巴（wing>0 才画；up 正=上扬，负=下垂）
        if (s.wing > 0) {
          const [ox, oy] = pts[n - 1];
          const [qx, qy] = pts[n - 2];
          const dx = ox - qx, dy = oy - qy, len = Math.hypot(dx, dy) || 1;
          c.beginPath();
          c.moveTo(ox, oy);
          c.lineTo(ox + (dx / len) * fw * s.wing, oy + (dy / len) * fw * s.wing - fw * s.up);
          c.lineTo(ox, oy - fw * (s.base + s.grow));
          c.closePath();
          c.fill();
        }
      }
      c.restore();
    }
  }

  // 提亮层（screen）：遮瑕提亮下眼周 + 高光（鼻梁/颧骨上方/唇珠）
  _drawBright(landmarks, plan, w, h, mirror) {
    const c = this.brightCtx;
    c.clearRect(0, 0, w, h);
    if (!landmarks) return;
    const fw = this._faceWidth(landmarks, w, h, mirror);

    // 遮瑕：下眼周提亮
    const concealer = plan.concealer;
    if (concealer) {
      for (const eye of [LEFT_EYE, RIGHT_EYE]) {
        const [ix, iy] = this._px(landmarks, eye.inner, w, h, mirror);
        const [ox, oy] = this._px(landmarks, eye.outer, w, h, mirror);
        const [bx, by] = this._px(landmarks, eye.bottom, w, h, mirror);
        const eyeW = Math.hypot(ix - ox, iy - oy);
        this._radial(c, (ix + ox) / 2, by + eyeW * 0.3, eyeW * 0.6, eyeW * 0.4, concealer.shade, concealer.coverage ?? 0.35);
      }
    }
    // 高光
    const hl = plan.highlighter;
    if (hl) {
      const a = hl.opacity ?? 0.3;
      // 鼻梁：沿中线几点叠加成竖条
      for (const i of NOSE_BRIDGE) {
        const [nx, ny] = this._px(landmarks, i, w, h, mirror);
        this._radial(c, nx, ny, fw * 0.03, fw * 0.06, hl.color, a * 0.8);
      }
      // 颧骨上方
      for (const ch of [RIGHT_CHEEK, LEFT_CHEEK]) {
        const [chx, chy] = this._px(landmarks, ch, w, h, mirror);
        this._radial(c, chx, chy - fw * 0.04, fw * 0.09, fw * 0.05, hl.color, a);
      }
      // 唇珠
      const [cux, cuy] = this._px(landmarks, CUPID, w, h, mirror);
      this._radial(c, cux, cuy - fw * 0.01, fw * 0.025, fw * 0.018, hl.color, a * 0.7);
    }
  }

  // 美瞳层：瞳孔留透明 + 虹膜上色 + 外圈深色放大环；裁在眼开口内（眨眼消失）
  _drawIris(landmarks, plan, w, h, mirror) {
    const c = this.irisCtx;
    c.clearRect(0, 0, w, h);
    const lens = plan.lens;
    if (!lens || !(lens.opacity > 0) || landmarks.length < 478) return;
    const op = lens.opacity ?? 0.35;
    const body = Math.min(0.6, op * 1.4); // 虹膜体填实但不过
    const ringA = Math.min(0.55, op * 1.5); // 环更淡，避免黑 halo
    const ring = this._darken(lens.color, 0.55); // 限制环（不要太深）
    for (const [iris, eye] of [[RIGHT_IRIS, RIGHT_EYE], [LEFT_IRIS, LEFT_EYE]]) {
      const [cx, cy] = this._px(landmarks, iris[0], w, h, mirror); // 虹膜中心
      const [ex, ey] = this._px(landmarks, iris[1], w, h, mirror); // 边缘点
      const r = Math.hypot(cx - ex, cy - ey) * 1.0; // 贴合自然虹膜，不外溢到眼白
      const [ix, iy] = this._px(landmarks, eye.inner, w, h, mirror);
      const [ox, oy] = this._px(landmarks, eye.outer, w, h, mirror);
      const [tx, ty] = this._px(landmarks, eye.top, w, h, mirror);
      const [bx, by] = this._px(landmarks, eye.bottom, w, h, mirror);
      c.save();
      // 眼开口椭圆裁剪（高度小=眯眼时美瞳自然消失）
      c.beginPath();
      c.ellipse((ix + ox) / 2, (ty + by) / 2, Math.hypot(ix - ox, iy - oy) / 2 * 1.05, Math.abs(by - ty) / 2 * 1.08, 0, 0, Math.PI * 2);
      c.clip();
      const g = c.createRadialGradient(cx, cy, r * 0.22, cx, cy, r);
      g.addColorStop(0.0, this._rgba(lens.color, 0)); // 瞳孔透明（保留真实黑瞳）
      g.addColorStop(0.36, this._rgba(lens.color, 0)); // 瞳孔范围
      g.addColorStop(0.46, this._rgba(lens.color, body)); // 虹膜体
      g.addColorStop(0.86, this._rgba(lens.color, body));
      g.addColorStop(0.95, this._rgba(ring, ringA)); // 细限制环（贴在虹膜边缘）
      g.addColorStop(1.0, this._rgba(ring, 0)); // 羽化
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }

  _darken(hex, f) {
    const m = hex.replace("#", "");
    const n = parseInt(m.length === 3 ? m.split("").map((x) => x + x).join("") : m, 16);
    const r = Math.round(((n >> 16) & 255) * f);
    const g = Math.round(((n >> 8) & 255) * f);
    const b = Math.round((n & 255) * f);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }

  // 椭圆径向渐变（中心实、边缘透明），可旋转
  _radial(c, cx, cy, rx, ry, color, alpha, angle = 0) {
    c.save();
    c.globalAlpha = alpha;
    c.translate(cx, cy);
    if (angle) c.rotate(angle);
    c.scale(1, ry / rx);
    const g = c.createRadialGradient(0, 0, rx * 0.08, 0, 0, rx);
    g.addColorStop(0, color);
    g.addColorStop(1, this._rgba(color, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, rx, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  _rgba(hex, a) {
    const m = hex.replace("#", "");
    const n = parseInt(m.length === 3 ? m.split("").map((x) => x + x).join("") : m, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  _upload(tex, src) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  // plan: { lips:{...}, foundation:{shade,coverage} }（均可缺省）
  // skinCanvas: 皮肤分割掩码画布（可选）；提供则粉底与之相交
  render(video, landmarks, plan, mirror = true, skinCanvas = null, debug = 0, wipe = 1.0, intensity = 1.0) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const lips = plan && plan.lips;
    const fnd = plan && plan.foundation;
    const useSkin = !!skinCanvas;

    this._upload(this.camTex, video);
    this._drawLipMask(lips ? landmarks : null, w, h, mirror);
    this._drawFaceMask(fnd ? landmarks : null, w, h, mirror);
    this._drawOverlay(landmarks, plan || {}, w, h, mirror);
    this._drawEye(landmarks, plan || {}, w, h, mirror);
    this._drawBright(landmarks, plan || {}, w, h, mirror);
    this._drawIris(landmarks, plan || {}, w, h, mirror);
    this._upload(this.lipMaskTex, this.lipMaskCanvas);
    this._upload(this.faceMaskTex, this.faceMaskCanvas);
    this._upload(this.overlayTex, this.overlayCanvas);
    this._upload(this.eyeTex, this.eyeCanvas);
    this._upload(this.brightTex, this.brightCanvas);
    this._upload(this.irisTex, this.irisCanvas);
    if (useSkin) this._upload(this.skinTex, skinCanvas);

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.camTex);
    gl.uniform1i(this.u.cam, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lipMaskTex);
    gl.uniform1i(this.u.lipMask, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.faceMaskTex);
    gl.uniform1i(this.u.faceMask, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.skinTex);
    gl.uniform1i(this.u.skin, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
    gl.uniform1i(this.u.overlay, 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.eyeTex);
    gl.uniform1i(this.u.eye, 5);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.brightTex);
    gl.uniform1i(this.u.bright, 6);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, this.irisTex);
    gl.uniform1i(this.u.iris, 7);
    const eyeFinish = plan && plan.eyeshadow && plan.eyeshadow.finish;
    gl.uniform1f(this.u.eyeShimmer, eyeFinish === "shimmer" ? 0.6 : 0.0);
    gl.uniform1f(this.u.useSkin, useSkin ? 1.0 : 0.0);
    gl.uniform1f(this.u.debug, debug);
    gl.uniform1f(this.u.wipe, wipe);
    gl.uniform1f(this.u.intensity, intensity);
    const fw = landmarks ? this._faceWidth(landmarks, w, h, mirror) : 200;
    gl.uniform2f(this.u.texel, 1 / w, 1 / h);
    gl.uniform1f(this.u.fndRadius, Math.max(2, fw * 0.016));

    // 口红
    if (lips) {
      gl.uniform3fv(this.u.lip, hexToRgb01(lips.color));
      gl.uniform1f(this.u.lipOpacity, lips.opacity ?? 0.5);
      // 质地：matte=天鹅绒(压光泽,无高光)；moist/satin=柔和缎光
      const matte = lips.style === "matte";
      gl.uniform1f(this.u.lipMatte, matte ? 0.55 : 0.0);
      gl.uniform1f(this.u.lipSheen, matte ? 0.0 : 0.4);
      gl.uniform1f(this.u.sheenLo, matte ? 0.95 : 0.8);
    } else {
      gl.uniform1f(this.u.lipOpacity, 0.0);
      gl.uniform1f(this.u.lipMatte, 0.0);
      gl.uniform1f(this.u.lipSheen, 0.0);
    }
    // 粉底
    if (fnd) {
      gl.uniform3fv(this.u.fnd, hexToRgb01(fnd.shade));
      gl.uniform1f(this.u.fndCov, fnd.coverage ?? 0.0);
    } else {
      gl.uniform1f(this.u.fndCov, 0.0);
    }
    gl.uniform1f(this.u.mirror, mirror ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
