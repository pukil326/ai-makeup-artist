"""极薄后端代理：既做静态服务器，又把 AI 审美层请求转发给 Claude。

为什么要后端：
  - 隐藏 ANTHROPIC_API_KEY（前端绝不放密钥、绝不直连大模型）。
  - 摄像头需要 https 或 localhost；本服务把页面跑在 localhost。

设计纪律：AI 只在用户点「AI 帮我上妆」时被调用一次，方案在前端缓存复用，
绝不每帧调用。

运行：
  pip install -r requirements.txt
  PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
  python server/app.py
没有配置 Key 时，/api/analyze 返回 503，前端自动回退到本地兜底（仍可演示闭环）。
"""

import base64
import functools
import json
import os
import socket
import ssl
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 静态根目录 = 仓库根（app.py 的上一级）
ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path) -> None:
    """零依赖加载 .env：把 KEY=VALUE 写进环境变量。
    已存在的真·环境变量优先（不覆盖）；空值/注释忽略。"""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if val and not os.environ.get(key):
            os.environ[key] = val


# 仓库根的 .env（用完可自行清空 key 或删除该文件）
load_dotenv(ROOT / ".env")

MODEL = os.environ.get("AIMAKEUP_MODEL", "claude-opus-4-8")

# 「妆容方案 JSON」契约 —— 用结构化输出强约束，保证前端能稳定解析。
# 结构化输出不支持数值 min/max，取值范围在 system 提示里约束。
MAKEUP_SCHEMA = {
    "type": "object",
    "properties": {
        "diagnosis": {
            "type": "object",
            "properties": {
                "undertone": {"type": "string", "enum": ["cool", "warm", "neutral"]},
                "face_shape": {"type": "string"},
                "summary": {"type": "string"},
            },
            "required": ["undertone", "face_shape", "summary"],
            "additionalProperties": False,
        },
        "makeup": {
            "type": "object",
            "properties": {
                "foundation": {
                    "type": "object",
                    "properties": {
                        "shade": {"type": "string"},
                        "coverage": {"type": "number"},
                    },
                    "required": ["shade", "coverage"],
                    "additionalProperties": False,
                },
                "concealer": {
                    "type": "object",
                    "properties": {
                        "shade": {"type": "string"},
                        "coverage": {"type": "number"},
                    },
                    "required": ["shade", "coverage"],
                    "additionalProperties": False,
                },
                "highlighter": {
                    "type": "object",
                    "properties": {
                        "color": {"type": "string"},
                        "opacity": {"type": "number"},
                    },
                    "required": ["color", "opacity"],
                    "additionalProperties": False,
                },
                "contour": {
                    "type": "object",
                    "properties": {
                        "color": {"type": "string"},
                        "opacity": {"type": "number"},
                    },
                    "required": ["color", "opacity"],
                    "additionalProperties": False,
                },
                "eyeliner": {
                    "type": "object",
                    "properties": {
                        "color": {"type": "string"},
                        "opacity": {"type": "number"},
                        "style": {
                            "type": "string",
                            "enum": ["inner", "natural", "elongated", "winged", "droopy"],
                        },
                    },
                    "required": ["color", "opacity", "style"],
                    "additionalProperties": False,
                },
                "lens": {
                    "type": "object",
                    "properties": {
                        "color": {"type": "string"},
                        "opacity": {"type": "number"},
                    },
                    "required": ["color", "opacity"],
                    "additionalProperties": False,
                },
                "lips": {
                    "type": "object",
                    "properties": {
                        "color": {"type": "string"},
                        "opacity": {"type": "number"},
                        "style": {"type": "string", "enum": ["moist", "matte"]},
                    },
                    "required": ["color", "opacity", "style"],
                    "additionalProperties": False,
                },
                "blush": {
                    "type": "object",
                    "properties": {
                        "color": {"type": "string"},
                        "opacity": {"type": "number"},
                        "placement": {
                            "type": "string",
                            "enum": ["apple", "diagonal", "aegyo", "sunburn"],
                        },
                    },
                    "required": ["color", "opacity", "placement"],
                    "additionalProperties": False,
                },
                "eyeshadow": {
                    "type": "object",
                    "properties": {
                        "color": {"type": "string"},
                        "opacity": {"type": "number"},
                        "finish": {"type": "string", "enum": ["matte", "shimmer"]},
                        "technique": {
                            "type": "string",
                            "enum": ["wash", "gradient", "lower", "aegyo"],
                        },
                    },
                    "required": ["color", "opacity", "finish", "technique"],
                    "additionalProperties": False,
                },
                "eyebrow": {
                    "type": "object",
                    "properties": {
                        "color": {"type": "string"},
                        "opacity": {"type": "number"},
                    },
                    "required": ["color", "opacity"],
                    "additionalProperties": False,
                },
            },
            "required": [
                "foundation", "concealer", "highlighter", "contour",
                "eyeliner", "lens", "lips", "blush", "eyeshadow", "eyebrow",
            ],
            "additionalProperties": False,
        },
        "reason": {"type": "string"},
    },
    "required": ["diagnosis", "makeup", "reason"],
    "additionalProperties": False,
}

# 核心竞争力：把化妆师的审美逻辑写成稳定提示词。
SYSTEM_PROMPT = """你是资深彩妆师兼色彩顾问。分析图中人物的肤色冷暖（undertone）、脸型（face_shape）、五官特点，给出最适合 TA 的日常妆容方案。

【审美定位 · 非常重要】本产品面向亚洲、尤其中国女性。妆容必须走**中式 / 日韩风**，**绝不要欧美风**：
- 追求：伪素颜、水光肌、清透显白、减龄、自然、有亲和力。
- 眉形：自然平眉或微微上挑，**不要欧美式高挑棱角眉**；眉色比发色浅一号、柔和。
- 眼影：柔和的棕调 / 橘调 / 玫调**渐变晕染**，内敛不夸张；氛围感/约会可带细闪珠光，通勤/日常用哑光。
- 腮红：自然提气色，圆脸斜扫收缩；**不要欧美式浓重修容/晒伤感**。
- 遮瑕(concealer)：提亮下眼周、盖黑眼圈/泛红；shade 比粉底**亮一号**的提亮色；coverage 0.3–0.5。
- 高光(highlighter)：颧骨上方、鼻梁、唇珠提亮，香槟/珠光白等浅色，自然不浮夸；opacity 0.2–0.4。
- 修容(contour)：很轻，圆脸可两颊外侧/下颌**轻轻压暗收脸**；冷棕/taupe；opacity 0.12–0.25；**严禁欧美式重修容**。
- 眼线(eyeliner)：沿上睫毛根的**自然细线**、可微微拉长，日韩感不夸张上扬；深棕或黑；opacity 0.4–0.6。
- 美瞳(lens)：日韩流行的放大/变色隐形眼镜，提亮放大瞳孔。中国女性首选**自然棕/黑/茶色**(如 #4A3328 深棕、#6B4A30 茶棕)，**绝不要夸张的蓝紫绿**。日常自然棕、opacity 0.25–0.4；约会/氛围感茶棕可稍明显 0.4–0.5。
- 唇：水润为主，可带微咬唇 / 渐变感；正红 / 玫调 / 豆沙 / 珊瑚按肤调选。
- **避免**：欧美深邃 cut-crease、浓重大地色烟熏、夸张重修容阴影、厚重哑光糊面、过度浓妆。

审美规则（务必体现在选色与理由里）：
- 冷调皮肤：莓果色 / 玫调唇、冷棕或灰棕眼影更显白高级；暖调皮肤：珊瑚 / 奶杏 / 砖红更衬气色。
- 圆脸适合斜向扫的腮红做收缩；长脸用横向腮红；脸型清晰可走干净通透的伪素颜。
- foundation（粉底）：选**贴合 TA 肤色冷暖、且明度等于或略亮于肤色**的自然粉底色号（shade，#RRGGBB）。亚洲妆容粉底偏显白通透，**宁可贴肤或略提亮，绝不能比肤色暗、发黄或发沉**——这是用化妆品均匀肤色，不是滤镜磨皮。coverage 取 0.2–0.5 的轻薄到中等。
- 整体追求“伪素颜”“更显白”“更高级”的实时试妆观感，不要浓妆。

输出约束：
- **整体克制：宁淡勿浓、宁少勿多。** 日常/伪素颜各部位 opacity / coverage 普遍取区间**下限**；眼影/眼线/修容/高光尤其要轻（甚至接近 0），目标是"看不出明显化了妆，但更精致显气色"。只有约会/氛围感才稍加重点。切忌九个部位都拉满 = 浓妆/廉价。
- 颜色一律用 #RRGGBB 十六进制。
- 各部位 opacity / coverage 按所给风格的浓淡区间取值（未指定时用 0.25–0.5 的自然范围）。
- lips.style 取 moist 或 matte；日常/约会优先 moist，通勤可 matte。
- eyeshadow.finish 取 matte 或 shimmer；氛围感/约会可用 shimmer（细闪珠光，日韩感），通勤/日常用 matte。

【形与技法 · 按风格和脸型千人千面，不只选颜色】
- blush.placement（腮红位置）：apple 苹果肌(甜美/圆脸慎用) / diagonal 斜扫(收脸显瘦，圆脸方脸首选) / aegyo 卧蚕下(无辜减龄) / sunburn 晒伤腮(横扫鼻颊，少女感)。
- eyeliner.style（眼线）：inner 内眼线(最自然，放大眼) / natural 自然细线 / elongated 拉长(显眼型狭长) / winged 上扬(媚/气场) / droopy 下垂(无辜温柔，日系)。圆眼可拉长，细长眼可自然，下垂眼适合上扬提神。
- eyeshadow.technique（眼影技法）：wash 单色晕染 / gradient 上下渐变(睫毛根深、上方浅) / lower 加下眼影 / aegyo 卧蚕提亮。日常用 wash，约会/氛围感可 gradient 或 aegyo。
- 选择要结合 TA 的眼型、脸型、风格给出**有针对性**的形与技法，并在 reason 里点出为什么这样配。
- diagnosis.summary 与 reason 用一句简洁中文，reason 要说清“为什么这套妆适合 TA”，可带一点专业又好传播的点评，并体现所选风格与粉底思路。"""


# 风格档：同一张脸按不同场景给出明显不同的妆（key → (展示名, 给模型的风格指示)）
STYLES = {
    "daily": ("日常", "伪素颜日常：干净通透、自然、低饱和。opacity 0.25–0.45。"),
    "commute": (
        "通勤",
        "职场通勤：克制利落、低饱和半哑光，唇偏裸调或低调玫调，眼影浅、腮红淡。opacity 0.3–0.45，唇可 matte。",
    ),
    "date": (
        "约会",
        "约会甜美：粉嫩显气色，水润唇、提亮腮红、柔和暖光眼影，放电感。opacity 0.4–0.55，唇 moist。",
    ),
    "party": (
        "氛围感",
        "夜场氛围感：有记忆点，唇色更饱和、眼影加深、可带微光，整体浓一档但仍精致。opacity 0.5–0.65，唇 moist。",
    ),
}


def analyze_image(data_url: str, style: str = "daily") -> dict:
    """调用 Claude 多模态视觉，返回妆容方案 dict。需要 anthropic SDK + API Key。"""
    import anthropic  # 延迟导入：未安装时给出清晰报错

    label, guidance = STYLES.get(style, STYLES["daily"])
    user_text = f"请按「{label}」风格，分析这张脸并给出最适合 TA 的妆容方案。风格要求：{guidance}"

    # 解析 dataURL: "data:image/jpeg;base64,...."
    media_type = "image/jpeg"
    if "," in data_url:
        header, b64 = data_url.split(",", 1)
        if header.startswith("data:") and ";" in header:
            media_type = header[5:].split(";", 1)[0] or "image/jpeg"
    else:
        b64 = data_url

    base64.b64decode(b64)  # 校验合法

    client = anthropic.Anthropic()  # 从环境变量读 ANTHROPIC_API_KEY
    response = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        output_config={"format": {"type": "json_schema", "schema": MAKEUP_SCHEMA}},
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64,
                        },
                    },
                    {"type": "text", "text": user_text},
                ],
            }
        ],
    )
    # 结构化输出保证首个 text block 是合法 JSON
    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text)


class Handler(SimpleHTTPRequestHandler):
    """GET 走标准静态文件服务；POST /api/analyze 走 AI 代理。"""

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # 健康检查：手机直接打开 /api/health 就能看到所连服务器是否带 key
        if self.path.split("?", 1)[0] == "/api/health":
            self._send_json(
                200,
                {
                    "hasKey": bool(os.environ.get("ANTHROPIC_API_KEY")),
                    "model": MODEL,
                },
            )
            return
        return super().do_GET()  # 其余走静态文件

    def do_POST(self):
        if self.path != "/api/analyze":
            self._send_json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send_json(400, {"error": "bad json"})
            return

        image = payload.get("image")
        if not image:
            self._send_json(400, {"error": "missing image"})
            return
        style = payload.get("style", "daily")
        if style not in STYLES:
            style = "daily"

        if not os.environ.get("ANTHROPIC_API_KEY"):
            self._send_json(503, {"error": "未配置 ANTHROPIC_API_KEY（前端将回退本地兜底）"})
            return

        try:
            plan = analyze_image(image, style)
            self._send_json(200, plan)
        except ModuleNotFoundError:
            self._send_json(
                503, {"error": "未安装 anthropic SDK，请先 pip install -r requirements.txt"}
            )
        except Exception as e:  # noqa: BLE001 - 演示用，把错误透传给前端日志
            self._send_json(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt, *args):
        sys.stderr.write("[server] " + (fmt % args) + "\n")


CERT = ROOT / "server" / "cert.pem"
KEY = ROOT / "server" / "key.pem"


def local_ip() -> str:
    """拿本机局域网 IP（手机访问用）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip: str) -> bool:
    """缺证书时用 openssl 自动生成自签证书（含 IP/localhost 的 SAN，手机更友好）。
    成功返回 True；没有 openssl 则返回 False。"""
    if CERT.exists() and KEY.exists():
        return True
    san = f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}"
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(KEY), "-out", str(CERT), "-days", "365",
        "-subj", "/CN=aimakeup", "-addext", san,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        print(f"  已生成自签证书：{CERT.name} / {KEY.name}")
        return True
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        print(f"  ⚠️  自动生成证书失败（{type(e).__name__}）。请手动用 openssl 生成，"
              f"或不带 HTTPS 在本机 localhost 使用。")
        return False


def main():
    # Windows 控制台默认 GBK，输出 emoji 会崩；统一切到 UTF-8
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", line_buffering=True)
        except Exception:
            pass

    port = int(os.environ.get("PORT", "8000"))
    # 默认绑定 0.0.0.0，局域网内手机可达
    host = os.environ.get("HOST", "0.0.0.0")
    ip = local_ip()

    # 是否启用 HTTPS：手机经局域网 IP 访问摄像头，必须是 https（或 localhost）
    # 设 AIMAKEUP_HTTP=1 可强制走纯 http（仅本机 localhost 能用摄像头）
    want_https = os.environ.get("AIMAKEUP_HTTP", "") != "1"
    use_https = want_https and ensure_cert(ip)

    handler = functools.partial(Handler, directory=str(ROOT))
    # 绑定端口；若被占用/拒绝（多为另一个实例还在跑），自动顺延端口
    server = None
    for p in range(port, port + 12):
        try:
            server = ThreadingHTTPServer((host, p), handler)
            port = p
            break
        except OSError as e:
            print(f"  端口 {p} 不可用（{getattr(e, 'winerror', e)}），尝试 {p + 1}…")
    if server is None:
        print("  ⚠️  连续多个端口都绑不上。多半是已有一个服务器在跑——"
              "先关掉旧的那个窗口（Ctrl+C），或重启电脑后重试。")
        return

    scheme = "http"
    if use_https:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(CERT), keyfile=str(KEY))
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        scheme = "https"

    has_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
    print(f"\n  实时 AI 彩妆 已启动")
    print(f"  本机访问：    {scheme}://localhost:{port}")
    print(f"  手机/局域网： {scheme}://{ip}:{port}")
    print(f"  模型：{MODEL}")
    print(f"  ANTHROPIC_API_KEY：{'已配置 ✅ 走真·AI' if has_key else '未配置 ⚠️  走本地兜底'}")
    if use_https:
        print("  提示：自签证书，手机首次访问会有安全警告 → 点「高级 / 继续访问」即可。")
    elif want_https:
        print("  ⚠️  未启用 HTTPS：手机经局域网 IP 无法调用摄像头，仅本机 localhost 可用。")
    print("  Ctrl+C 退出\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出。")


if __name__ == "__main__":
    main()
