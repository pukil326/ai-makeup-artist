"""离屏管道测试：不需要真 API Key，用假响应验证后端解析链路。
跑法：python server/test_backend.py
真·模型输出质量需配 ANTHROPIC_API_KEY 后用真实人脸验证（见 README）。
"""
import base64
import importlib.util
import json
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("aimakeup_app", HERE / "app.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


def test_schema_is_valid_json():
    json.dumps(app.MAKEUP_SCHEMA)  # 可序列化即结构合法
    assert app.MAKEUP_SCHEMA["required"] == ["diagnosis", "makeup", "reason"]
    print("✓ MAKEUP_SCHEMA 合法")


def test_analyze_parses_structured_output():
    # 一个符合契约的假方案（模拟 Claude 结构化输出的首个 text block）
    fake_plan = {
        "diagnosis": {"undertone": "cool", "face_shape": "oval", "summary": "冷调通透"},
        "makeup": {
            "foundation": {"shade": "#E8C9B0", "coverage": 0.35},
            "concealer": {"shade": "#F2DBC8", "coverage": 0.35},
            "highlighter": {"color": "#FBEFE2", "opacity": 0.3},
            "contour": {"color": "#9C7A66", "opacity": 0.18},
            "eyeliner": {"color": "#3A2A22", "opacity": 0.5, "style": "natural"},
            "lens": {"color": "#4A3328", "opacity": 0.32},
            "lips": {"color": "#C0506B", "opacity": 0.5, "style": "moist"},
            "blush": {"color": "#E89AA0", "opacity": 0.3, "placement": "diagonal"},
            "eyeshadow": {"color": "#A87C6B", "opacity": 0.4, "finish": "shimmer", "technique": "gradient"},
            "eyebrow": {"color": "#6B4A3A", "opacity": 0.5},
        },
        "reason": "冷调配莓果唇更显白。",
    }

    captured = {}

    class _Block:
        type = "text"
        text = json.dumps(fake_plan, ensure_ascii=False)

    class _Resp:
        content = [_Block()]

    class _Messages:
        def create(self, **kwargs):
            captured.update(kwargs)  # 记录请求，校验构造是否正确
            return _Resp()

    class _FakeClient:
        def __init__(self, *a, **k):
            self.messages = _Messages()

    # 用假客户端替换真实 anthropic.Anthropic
    import anthropic
    real = anthropic.Anthropic
    anthropic.Anthropic = _FakeClient
    try:
        tiny_jpeg = base64.b64encode(b"\xff\xd8\xff\xd9").decode()
        data_url = "data:image/jpeg;base64," + tiny_jpeg
        plan = app.analyze_image(data_url)
    finally:
        anthropic.Anthropic = real

    # 1) 返回的方案结构正确
    assert plan == fake_plan, "解析结果与输入不一致"
    # 2) 请求构造正确：模型、结构化输出、图片块
    assert captured["model"] == app.MODEL
    assert captured["output_config"]["format"]["type"] == "json_schema"
    content = captured["messages"][0]["content"]
    img = next(c for c in content if c["type"] == "image")
    assert img["source"]["type"] == "base64"
    assert img["source"]["media_type"] == "image/jpeg"
    base64.b64decode(img["source"]["data"])  # 透传的 base64 合法
    print("✓ analyze_image 解析 + 请求构造正确")
    print("  发往模型：", captured["model"], "| 结构化输出已启用 | 含 base64 图片块")


if __name__ == "__main__":
    test_schema_is_valid_json()
    test_analyze_parses_structured_output()
    print("\n全部通过 ✅ 后端管道就绪。配置 ANTHROPIC_API_KEY 后即可走真·AI。")
