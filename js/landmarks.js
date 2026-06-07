// MediaPipe Face Mesh 关键点索引常量
// FaceLandmarker 输出 478 个归一化点（x,y in [0,1]）。
// 这些索引是 FaceMesh 拓扑里约定俗成的轮廓点。

// 嘴唇外轮廓（闭合环路）
export const LIPS_OUTER = [
  61, 185, 40, 39, 37, 0, 267, 269, 270, 409,
  291, 375, 321, 405, 314, 17, 84, 181, 91, 146,
];

// 嘴唇内轮廓（口腔开口，用 evenodd 挖空，避免给牙齿/嘴缝上色）
export const LIPS_INNER = [
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415,
  308, 324, 318, 402, 317, 14, 87, 178, 88, 95,
];

// 眼睛角点：用于计算眼影/眼睛中心与尺寸
// 注意：subject-right = 画面左侧（未镜像时）
export const RIGHT_EYE = { inner: 133, outer: 33, top: 159, bottom: 145 };
export const LEFT_EYE = { inner: 362, outer: 263, top: 386, bottom: 374 };

// 脸颊（腮红中心）——苹果肌附近
export const RIGHT_CHEEK = 50;
export const LEFT_CHEEK = 280;

// 眉毛轮廓（上沿 + 下沿，构成可填充的细长多边形）
export const RIGHT_EYEBROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
export const LEFT_EYEBROW = [336, 296, 334, 293, 300, 276, 283, 282, 295, 285];

// 用于估计脸宽（左右脸颊外缘），驱动各部位尺寸自适应
export const FACE_LEFT = 234;
export const FACE_RIGHT = 454;

// 脸部轮廓（FaceMesh FACE_OVAL，按顺序连成的脸型轮廓环）——用于粉底的脸皮遮罩
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109,
];

// 上睫毛根线（内→外），用于眼线
export const RIGHT_EYE_UPPER = [133, 173, 157, 158, 159, 160, 161, 246, 33];
export const LEFT_EYE_UPPER = [362, 398, 384, 385, 386, 387, 388, 466, 263];

// 虹膜关键点（478 点模型自带）：[中心, 上, 右, 下, 左]，用于美瞳
export const RIGHT_IRIS = [468, 469, 470, 471, 472];
export const LEFT_IRIS = [473, 474, 475, 476, 477];

// 鼻梁中线（上→下），用于鼻梁高光 / 鼻影参考
export const NOSE_BRIDGE = [168, 197, 195, 5];
// 唇珠（上唇中点上方），用于唇珠高光
export const CUPID = 0;
