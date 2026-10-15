"""Draw the synthetic sample factory as PNG, DXF and vector PDF, plus its ground truth.

Plan is 40 m x 24 m. Walls are solid, doors are gaps with thin swing arcs, and
there are room names, printed areas and thin machine outlines.

    python3 tools/make_sample_plan.py data/samples

writes factory_plan.png (30 px/m), factory_plan.dxf (mm, layers A-WALL / A-DOOR / A-ANNO),
factory_plan.pdf (1:100 on A2) and factory_truth.json (exact room areas and doors).
"""

import json
import math
import sys
from pathlib import Path

W, H = 40, 24
EXT, INT = 0.3, 0.15  # wall thickness in metres

# (x0, y0, x1, y1, thickness, [(gap start, gap width, swing)]) ; y grows downwards.
# swing = (side, hinge): side +1 = leaf opens towards +y (or +x); hinge 0 = at gap start, 1 = at gap end.
WALLS = [
    (0, 0, W, 0, EXT, [(35, 4.0, None)]),  # north, loading bay roller door
    (
        0,
        H,
        W,
        H,
        EXT,
        [(4, 1.0, (-1, 1))],
    ),  # south, lockers exit (opens inwards: should be flagged)
    (0, 0, 0, H, EXT, []),
    (W, 0, W, H, EXT, [(14, 1.0, (+1, 0))]),  # east emergency exit, opens outwards
    (10, 0, 10, H, INT, [(5, 0.9, (+1, 0)), (16, 1.2, (+1, 0))]),
    (0, 10, 10, 10, INT, [(6, 0.9, (-1, 0))]),
    (0, 12, 10, 12, INT, [(2, 0.9, (-1, 0)), (7, 0.9, (-1, 0))]),
    (5, 12, 5, H, INT, []),
    (5, 0, 5, 10, INT, [(4, 0.9, (+1, 0))]),
    (24, 0, 24, 9, INT, [(6, 1.2, (+1, 0))]),
    (24, 9, W, 9, INT, [(27, 3.0, None)]),  # wide opening storage -> hall
    (34, 0, 34, 9, INT, [(4, 1.0, (+1, 0))]),
]
# rooms as wall-centreline rectangles; net area subtracts half of each bounding wall
ROOMS = [
    ("Office A", "office", 0, 0, 5, 10),
    ("Office B", "office", 5, 0, 10, 10),
    ("Corridor", "corridor", 0, 10, 10, 12),
    ("Lockers", "welfare", 0, 12, 5, 24),
    ("Canteen", "welfare", 5, 12, 10, 24),
    ("Storage", "storage", 24, 0, 34, 9),
    ("Loading bay", "loading_bay", 34, 0, 40, 9),
]
MACHINES = [
    (14, 4, 3, 2),
    (18, 4, 3, 2),
    (14, 14, 6, 3),
    (24, 15, 4, 4),
    (30, 15, 4, 2),
]


def half(v, vertical):
    """Half thickness of the wall running along x = v (vertical) or y = v (horizontal)."""
    for x0, y0, x1, y1, t, _ in WALLS:
        if vertical and x0 == x1 == v:
            return t / 2
        if not vertical and y0 == y1 == v:
            return t / 2
    return 0


def net_area(x0, y0, x1, y1):
    return (x1 - x0 - half(x0, True) - half(x1, True)) * (
        y1 - y0 - half(y0, False) - half(y1, False)
    )


def hall_area():
    # hall = x 10..40, y 0..24, minus the storage + loading bay block (x 24..40, y 0..9)
    total = (W - 10 - half(10, True) - EXT / 2) * (H - EXT)
    block = (W - 24 - half(24, True) - EXT / 2 + INT) * (9 - EXT / 2 + INT / 2)
    return total - block


def segments():
    """Solid wall pieces as rectangles (x0, y0, x1, y1) in metres."""
    out = []
    for x0, y0, x1, y1, t, gaps in WALLS:
        horiz = y0 == y1
        a, b = (x0, x1) if horiz else (y0, y1)
        cur, pieces = a, []
        for g0, gw, _ in sorted(gaps):
            pieces.append((cur, g0))
            cur = g0 + gw
        pieces.append((cur, b))
        for s0, s1 in pieces:
            if s1 <= s0:
                continue
            e0 = t / 2 if s0 == a else 0  # extend wall ends so corners close
            e1 = t / 2 if s1 == b else 0
            if horiz:
                out.append((s0 - e0, y0 - t / 2, s1 + e1, y0 + t / 2))
            else:
                out.append((x0 - t / 2, s0 - e0, x0 + t / 2, s1 + e1))
    return out


def doors():
    out = []
    for x0, y0, x1, y1, t, gaps in WALLS:
        horiz = y0 == y1
        for g0, gw, swing in gaps:
            d = {
                "gap": (g0, gw),
                "horiz": horiz,
                "line": y0 if horiz else x0,
                "width": gw,
            }
            if swing:
                side, hinge = swing
                hp = g0 + (gw if hinge else 0)
                d.update(
                    hinge=(hp, y0) if horiz else (x0, hp), side=side, hinge_end=hinge
                )
            out.append(d)
    return out


def leaf_geometry(d):
    """Open leaf tip, closed leaf tip and their angles in degrees (y down)."""
    hx, hy = d["hinge"]
    r, s = d["width"], d["side"]
    sign = 1 if d["hinge_end"] == 0 else -1
    if d["horiz"]:
        tip, closed = (hx, hy + s * r), (hx + sign * r, hy)
    else:
        tip, closed = (hx + s * r, hy), (hx, hy + sign * r)
    a0 = math.degrees(math.atan2(tip[1] - hy, tip[0] - hx))
    a1 = math.degrees(math.atan2(closed[1] - hy, closed[0] - hx))
    return tip, closed, a0, a1


def arc_range(a0, a1):
    """The 90 degree sweep between two angles, as (start, end) going counter-clockwise in y-down terms."""
    lo, hi = sorted((a0, a1))
    return (hi, lo + 360) if hi - lo > 180 else (lo, hi)


def labels():
    out = [
        (n, (x0 + x1) / 2, (y0 + y1) / 2, net_area(x0, y0, x1, y1))
        for n, _, x0, y0, x1, y1 in ROOMS
    ]
    out.append(("Production hall", 20, 12, hall_area()))
    return out


def truth():
    rooms = [
        {
            "name": n,
            "type": t,
            "net_area_m2": round(net_area(*r), 2),
            "centre": [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2],
        }
        for n, t, *r in ROOMS
    ]
    rooms.append(
        {
            "name": "Production hall",
            "type": "production",
            "net_area_m2": round(hall_area(), 2),
            "centre": [20, 13],
        }
    )
    ds = []
    for d in doors():
        g0, gw = d["gap"]
        c = (g0 + gw / 2, d["line"]) if d["horiz"] else (d["line"], g0 + gw / 2)
        ds.append(
            {
                "centre": c,
                "width_m": gw,
                "swing_side": d.get("side"),
                "hinge": d.get("hinge"),
            }
        )
    return {
        "origin": "outer face of the north-west corner is (-0.15, -0.15)",
        "rooms": rooms,
        "doors": ds,
    }


# ---------- writers ----------


def write_png(path, S=30, M=60):
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (int(W * S + 2 * M), int(H * S + 2 * M)), "white")
    d = ImageDraw.Draw(img)

    def p(x, y):
        return (M + x * S, M + y * S)

    for x0, y0, x1, y1 in segments():
        d.rectangle([p(x0, y0), p(x1, y1)], fill="black")
    for door in doors():
        if "hinge" not in door:
            continue
        tip, _, a0, a1 = leaf_geometry(door)
        c, r = p(*door["hinge"]), door["width"] * S
        d.arc(
            [c[0] - r, c[1] - r, c[0] + r, c[1] + r],
            *arc_range(a0, a1),
            fill="black",
            width=1,
        )
        d.line([c, p(*tip)], fill="black", width=1)
    for x, y, w, h in MACHINES:
        d.rectangle([p(x, y), p(x + w, y + h)], outline="black", width=1)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 15)
    except OSError:
        font = ImageFont.load_default()
    for name, x, y, area in labels():
        d.text(p(x - 1.6, y - 0.7), name.upper(), fill="black", font=font)
        d.text(p(x - 1.6, y + 0.1), f"{area:.1f} m²", fill="black", font=font)
    d.text((M, 10), "SAMPLE FACTORY - 40 m x 24 m", fill="black", font=font)
    img.save(path)


def write_dxf(path):
    import ezdxf

    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4  # millimetres
    for name, color in (("A-WALL", 7), ("A-DOOR", 3), ("A-ANNO", 2), ("A-EQPM", 8)):
        doc.layers.add(name, color=color)
    msp = doc.modelspace()

    def mm(x, y):
        return (x * 1000, -y * 1000)  # DXF y grows upwards

    for x0, y0, x1, y1 in segments():
        pts = [mm(x0, y0), mm(x1, y0), mm(x1, y1), mm(x0, y1)]
        msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "A-WALL"})
        hatch = msp.add_hatch(color=7, dxfattribs={"layer": "A-WALL"})
        hatch.paths.add_polyline_path(pts, is_closed=True)
    for door in doors():
        if "hinge" not in door:
            continue
        tip, _, a0, a1 = leaf_geometry(door)
        msp.add_line(mm(*door["hinge"]), mm(*tip), dxfattribs={"layer": "A-DOOR"})
        s, e = arc_range(
            a0, a1
        )  # y-down angles; flipping y maps angle a -> -a and reverses direction
        msp.add_arc(
            mm(*door["hinge"]),
            door["width"] * 1000,
            -e,
            -s,
            dxfattribs={"layer": "A-DOOR"},
        )
    for x, y, w, h in MACHINES:
        msp.add_lwpolyline(
            [mm(x, y), mm(x + w, y), mm(x + w, y + h), mm(x, y + h)],
            close=True,
            dxfattribs={"layer": "A-EQPM"},
        )
    for name, x, y, area in labels():
        msp.add_text(
            name.upper(),
            height=300,
            dxfattribs={"layer": "A-ANNO", "insert": mm(x - 1.6, y - 0.3)},
        )
        msp.add_text(
            f"{area:.1f} m2",
            height=250,
            dxfattribs={"layer": "A-ANNO", "insert": mm(x - 1.6, y + 0.4)},
        )
    doc.saveas(path)


def write_pdf(path, scale=100):
    import fitz

    pt_per_m = 72 / 0.0254 / scale  # paper points per real metre
    doc = fitz.open()
    page = doc.new_page(
        width=1684, height=1191
    )  # A2 landscape: the 42 m building is 420 mm at 1:100

    def p(x, y):
        return fitz.Point(40 + x * pt_per_m, 80 + y * pt_per_m)

    for x0, y0, x1, y1 in segments():
        page.draw_rect(fitz.Rect(p(x0, y0), p(x1, y1)), color=None, fill=(0, 0, 0))
    for door in doors():
        if "hinge" not in door:
            continue
        tip, closed, a0, a1 = leaf_geometry(door)
        page.draw_line(p(*door["hinge"]), p(*tip), width=0.3)
        s, e = arc_range(a0, a1)
        pts = [
            p(
                door["hinge"][0]
                + door["width"] * math.cos(math.radians(s + (e - s) * k / 16)),
                door["hinge"][1]
                + door["width"] * math.sin(math.radians(s + (e - s) * k / 16)),
            )
            for k in range(17)
        ]
        page.draw_polyline(pts, width=0.3)
    for x, y, w, h in MACHINES:
        page.draw_rect(fitz.Rect(p(x, y), p(x + w, y + h)), width=0.3)
    for name, x, y, area in labels():
        page.insert_text(p(x - 1.6, y - 0.2), name.upper(), fontsize=8)
        page.insert_text(p(x - 1.6, y + 0.6), f"{area:.1f} m2", fontsize=7)
    page.insert_text(
        fitz.Point(40, 40), "SAMPLE FACTORY    SCALE 1:100 (A2)", fontsize=10
    )
    doc.save(path)


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    out.mkdir(parents=True, exist_ok=True)
    write_png(out / "factory_plan.png")
    write_dxf(out / "factory_plan.dxf")
    write_pdf(out / "factory_plan.pdf")
    (out / "factory_truth.json").write_text(json.dumps(truth(), indent=1))
    print("wrote", *(f.name for f in sorted(out.glob("factory_*"))))
