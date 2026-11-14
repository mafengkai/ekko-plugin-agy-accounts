#!/usr/bin/env python3
"""生成反重力多账号插件图标：256/512 px PNG，纯标准库（zlib + struct），无外部依赖。

图形语义：向上的箭头（反重力/悬浮）+ 下方递减的横线（升力/悬浮托举）。
用 SDF（有符号距离场）算覆盖率做抗锯齿，不依赖插值库。
"""
import math
import struct
import sys
import zlib


def _clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def round_rect(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    return math.hypot(ax, ay) + min(max(qx, qy), 0.0) - r


def capsule(px, py, x1, y1, x2, y2, r):
    vx, vy = x2 - x1, y2 - y1
    wx, wy = px - x1, py - y1
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else _clamp((wx * vx + wy * vy) / denom)
    return math.hypot(wx - vx * t, wy - vy * t) - r


def circle(px, py, cx, cy, r):
    return math.hypot(px - cx, py - cy) - r


def glyph(px, py, s):
    """返回箭头+悬浮线的 SDF，s 为缩放系数（基准 512 画布）。"""
    d = float("inf")
    # 箭头：竖杆 + 两条斜臂
    d = min(d, capsule(px, py, 256 * s, 168 * s, 256 * s, 306 * s, 17 * s))
    d = min(d, capsule(px, py, 256 * s, 100 * s, 182 * s, 190 * s, 17 * s))
    d = min(d, capsule(px, py, 256 * s, 100 * s, 330 * s, 190 * s, 17 * s))
    # 悬浮托举线：三条递减横线
    d = min(d, capsule(px, py, 156 * s, 350 * s, 356 * s, 350 * s, 11 * s))
    d = min(d, capsule(px, py, 190 * s, 392 * s, 322 * s, 392 * s, 11 * s))
    d = min(d, capsule(px, py, 222 * s, 434 * s, 290 * s, 434 * s, 11 * s))
    return d


def render(size):
    s = size / 512.0
    ss = 2  # 超采样倍数（配合 SDF 边缘足够平滑，性能可控）
    rows = []
    # 梯度端点：#7C4DFF（左上，蓝紫）→ #FF6FA5（右下，粉）
    c0 = (0x7C, 0x4D, 0xFF)
    c1 = (0xFF, 0x6F, 0xA5)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            bg_a = 0.0
            gr = gg = gb = 0.0
            gl_a = 0.0
            for oy in range(ss):
                for ox in range(ss):
                    px = x + (ox + 0.5) / ss
                    py = y + (oy + 0.5) / ss
                    # 圆角方形底
                    a = _clamp(0.5 - round_rect(px, py, size / 2.0, size / 2.0,
                                                size / 2.0, size / 2.0, 112 * s))
                    if a <= 0:
                        continue
                    bg_a += a
                    # 对角渐变
                    t = _clamp((px / size * 0.55) + (py / size * 0.45))
                    gr += (c0[0] + (c1[0] - c0[0]) * t) * a
                    gg += (c0[1] + (c1[1] - c0[1]) * t) * a
                    gb += (c0[2] + (c1[2] - c0[2]) * t) * a
                    # 图形（白色）
                    ga = _clamp(0.5 - glyph(px, py, s))
                    gl_a += ga * a
            n = ss * ss
            if bg_a <= 0:
                row += b"\x00\x00\x00\x00"
                continue
            r = gr / bg_a
            g = gg / bg_a
            b = gb / bg_a
            if gl_a > 0:
                # 白字覆盖，按覆盖比例混合
                cov = _clamp(gl_a / bg_a)
                r = r * (1 - cov) + 255 * cov
                g = g * (1 - cov) + 255 * cov
                b = b * (1 - cov) + 255 * cov
            alpha = _clamp(bg_a / n) * 255
            row += bytes((int(_clamp(r, 0, 255)), int(_clamp(g, 0, 255)),
                          int(_clamp(b, 0, 255)), int(_clamp(alpha, 0, 255))))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = b"".join(b"\x00" + r for r in rows)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


# ---------- 最终造型：向上箭头 + 倾斜轨道环 + 卫星点 ----------
def ellipse_ring(px, py, cx, cy, rx, ry, theta, stroke):
    dx, dy = px - cx, py - cy
    c, s = math.cos(theta), math.sin(theta)
    u = dx * c + dy * s
    v = -dx * s + dy * c
    k = math.hypot(u / rx, v / ry) - 1.0
    return abs(k) * min(rx, ry) - stroke / 2.0


def final_glyph(px, py, s):
    d = float("inf")
    # 向上箭头（竖杆 + 两条斜臂）
    d = min(d, capsule(px, py, 256 * s, 128 * s, 256 * s, 300 * s, 18 * s))
    d = min(d, capsule(px, py, 256 * s, 92 * s, 186 * s, 180 * s, 18 * s))
    d = min(d, capsule(px, py, 256 * s, 92 * s, 326 * s, 180 * s, 18 * s))
    # 倾斜轨道环（悬浮力场）
    d = min(d, ellipse_ring(px, py, 256 * s, 336 * s, 176 * s, 74 * s, math.radians(-14), 20 * s))
    # 轨道上的卫星点
    th = math.radians(-14)
    ang = math.radians(28)
    dx = (256 + 176 * math.cos(ang) - 256) * s
    dy = (336 + 74 * math.sin(ang) - 336) * s
    px2 = 256 * s + dx * math.cos(th) + dy * math.sin(th)
    py2 = 336 * s - dx * math.sin(th) + dy * math.cos(th)
    d = min(d, circle(px, py, px2, py2, 26 * s))
    return d


glyph = final_glyph

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "icon.png"
    size = int(sys.argv[2]) if len(sys.argv) > 2 else 512
    n = write_png(out, size, render(size))
    print(f"{out}: {size}x{size}, {n} bytes")
