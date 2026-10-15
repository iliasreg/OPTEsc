"""Wall and room IoU on the CubiCasa5K test set, for the CubiCasa CNN and for OPTEsc's own plan reader.

Runs on your PC and uses the GPU when there is one: NVIDIA (CUDA) or AMD (ROCm build of PyTorch, which
also reports itself as "cuda"), Apple (MPS), else CPU. Nothing from CubiCasa is stored in this repo:
the code is cloned and the data and weights are downloaded into a cache folder you choose.

Licences: CubiCasa5K data and weights are CC BY-NC 4.0 (non-commercial use only).

Setup (once):
    pip install torch            # pick the CUDA or ROCm build from pytorch.org for GPU
    pip install opencv-python scikit-image lmdb svgpathtools shapely pillow numpy gdown
    # Node 18+ for OPTEsc's own reader (tools/plan2grid_cli.mjs)

Run:
    python tools/cubicasa_eval.py --cache ~/cubicasa --download        # fetches code, data (~5.6 GB) and weights
    python tools/cubicasa_eval.py --cache ~/cubicasa --limit 50        # quick run on 50 test plans
    python tools/cubicasa_eval.py --cache ~/cubicasa --ours-only       # skip the CNN
    A stopped run picks up where it stopped (add --restart to start over). If the GPU runs out of
    memory, lower --tile (default 1024 px); a plan that still does not fit runs on the CPU.

Writes <cache>/optesc_eval/results.json, report.md, a few side-by-side pictures, and for each plan
the CNN's wall mask as a clean black-on-white image (walls_<id>.png) that the OPTEsc page can open.
"""

import argparse
import json
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CODE_URL = "https://github.com/CubiCasa/CubiCasa5k.git"
DATA_URL = "https://zenodo.org/record/2613548/files/cubicasa5k.zip"
WEIGHTS_GDRIVE = "1gRB7ez1e4H7a9Y09lLqRuna0luZO5VRK"  # model_best_val_loss_var.pkl, from the CubiCasa5k README

ROOM_CLS = [
    "Background",
    "Outdoor",
    "Wall",
    "Kitchen",
    "Living Room",
    "Bedroom",
    "Bath",
    "Hallway",
    "Railing",
    "Storage",
    "Garage",
    "Other rooms",
]
WALL = 2
INTERIOR = [3, 4, 5, 6, 7, 9, 10, 11]  # indoor room classes: "room" for the room IoU


def pick_device(pref):
    import torch

    if pref != "auto":
        return torch.device(pref)
    if torch.cuda.is_available():  # NVIDIA CUDA, or AMD ROCm (HIP) builds of PyTorch
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def describe(device):
    import torch

    if device.type == "cuda":
        kind = (
            f"ROCm {torch.version.hip}"
            if getattr(torch.version, "hip", None)
            else f"CUDA {torch.version.cuda}"
        )
        return f"{torch.cuda.get_device_name(0)} ({kind})"
    return device.type.upper()


def fetch(cache, download):
    code = cache / "CubiCasa5k"
    if not code.exists():
        subprocess.run(
            ["git", "clone", "--depth", "1", CODE_URL, str(code)], check=True
        )
    data = code / "data" / "cubicasa5k"
    if not data.exists():
        if not download:
            sys.exit(
                f"CubiCasa5K data not found at {data}. Re-run with --download, or unzip {DATA_URL} into {code / 'data'}."
            )
        z = cache / "cubicasa5k.zip"
        if not z.exists():
            subprocess.run(["curl", "-L", "-o", str(z), DATA_URL], check=True)
        with zipfile.ZipFile(z) as f:
            f.extractall(code / "data")
    weights = cache / "model_best_val_loss_var.pkl"
    if not weights.exists() and download:
        try:
            import gdown

            gdown.download(id=WEIGHTS_GDRIVE, output=str(weights), quiet=False)
        except Exception as e:  # noqa: BLE001
            print(
                f"Could not download the CNN weights ({e}). Get them from the CubiCasa5k README and save as {weights}."
            )
    return code, data, weights


def load_model(code, weights, device):
    import torch

    sys.path.insert(0, str(code))
    # Build the network directly: CubiCasa's get_model() also calls init_weights(), which loads an
    # ImageNet starting point (floortrans/models/model_1427.pth) that is not in their repo and is not
    # needed here, because the trained weights below replace every layer.
    from floortrans.models.hg_furukawa_original import hg_furukawa_original

    model = hg_furukawa_original(n_classes=51)
    n_classes = 44
    model.conv4_ = torch.nn.Conv2d(256, n_classes, bias=True, kernel_size=1)
    model.upsample = torch.nn.ConvTranspose2d(
        n_classes, n_classes, kernel_size=4, stride=4
    )
    ckpt = torch.load(str(weights), map_location="cpu", weights_only=False)
    model.load_state_dict(ckpt["model_state"])
    return model.eval().to(device)


def _cnn_once(model, image, device, tta, tile, fp16):
    """Runs the CNN at the plan's own resolution (the scale it was trained at), tile by tile so
    a big plan fits in GPU memory. Each tile keeps only its centre; the edges overlap."""
    import torch
    import torch.nn.functional as F

    h, w = image.shape[1:]
    margin = min(128, tile // 4)
    step = tile - 2 * margin
    out = np.zeros((h, w), np.uint8)
    for y0 in range(0, h, step):
        for x0 in range(0, w, step):
            ty0, tx0 = max(0, y0 - margin), max(0, x0 - margin)
            ty1, tx1 = min(h, y0 + step + margin), min(w, x0 + step + margin)
            x = image[:, ty0:ty1, tx0:tx1].unsqueeze(0).to(device)
            th, tw = x.shape[2:]
            with (
                torch.inference_mode(),
                torch.autocast(device.type, enabled=fp16 and device.type == "cuda"),
            ):
                acc = 0
                for t in [0, 1, 2, 3] if tta else [0]:
                    pred = torch.rot90(
                        model(torch.rot90(x, t, (2, 3))), -t, (2, 3)
                    ).float()
                    pred = F.interpolate(
                        pred[:, 21:33],
                        size=(th, tw),
                        mode="bilinear",
                        align_corners=True,
                    )
                    acc = acc + torch.softmax(pred, 1)
                    del pred
            cls = acc[0].argmax(0).to(torch.uint8).cpu().numpy()
            del acc, x
            cy1, cx1 = min(h, y0 + step), min(w, x0 + step)
            out[y0:cy1, x0:cx1] = cls[y0 - ty0 : cy1 - ty0, x0 - tx0 : cx1 - tx0]
    return out


def cnn_rooms(model, image, device, tta, tile, fp16):
    """image: float tensor 3xHxW in [-1, 1]. Returns (HxW room class map, where it ran).
    Out of GPU memory: retry with smaller tiles, then on the CPU."""
    import torch

    tries = (
        [(device, tile), (device, tile // 2)]
        if device.type == "cuda"
        else [(device, tile)]
    )
    tries.append((torch.device("cpu"), tile))
    for i, (dev, t) in enumerate(tries):
        try:
            model.to(dev)
            out = _cnn_once(model, image, dev, tta, t, fp16)
            model.to(device)
            return out, f"{dev.type}, {t} px tiles"
        except (
            RuntimeError
        ) as e:  # torch.OutOfMemoryError, or a raw 'CUDA error: out of memory'
            if "out of memory" not in str(e) or i == len(tries) - 1:
                raise
            print(f"  out of GPU memory with {t} px tiles, retrying", flush=True)
        finally:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()


def ours(rgb_u8, px_per_m, walls=None):
    """OPTEsc reader via Node. Returns HxW codes: 0 outside, 1 room, 2 wall, 3 opening."""
    h, w = rgb_u8.shape[:2]
    rgba = np.dstack([rgb_u8, np.full((h, w), 255, np.uint8)])
    with tempfile.TemporaryDirectory() as d:
        src, dst = Path(d) / "in.rgba", Path(d) / "out.u8"
        src.write_bytes(rgba.tobytes())
        cmd = [
            "node",
            str(HERE / "plan2grid_cli.mjs"),
            str(src),
            str(w),
            str(h),
            str(px_per_m),
            str(dst),
        ]
        if walls is not None:  # walls from the CNN, everything else from our reader
            (Path(d) / "walls.u8").write_bytes(walls.astype(np.uint8).tobytes())
            cmd += ["--walls", str(Path(d) / "walls.u8")]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if (
            r.returncode != 0
        ):  # e.g. no walls found: score it as reading nothing, and carry on
            msg = r.stderr.strip().splitlines() or ["failed"]
            print(
                "  OPTEsc reader failed on this plan:",
                next((line for line in msg if line.startswith("Error")), msg[-1]),
                flush=True,
            )
            return np.zeros((h, w), np.uint8)
        return np.fromfile(dst, np.uint8).reshape(h, w)


class IoU:
    def __init__(self):
        self.inter, self.union = {}, {}

    def add(self, name, pred, gt):
        self.add_counts(
            name,
            int(np.logical_and(pred, gt).sum()),
            int(np.logical_or(pred, gt).sum()),
        )

    def add_counts(self, name, inter, union):
        self.inter[name] = self.inter.get(name, 0) + inter
        self.union[name] = self.union.get(name, 0) + union

    def scores(self):
        return {
            k: round(self.inter[k] / self.union[k], 4) if self.union[k] else None
            for k in self.inter
        }


def picture(path, rgb, gt_cls, cnn_cls, our_codes):
    from PIL import Image

    pal = np.array(
        [[255, 255, 255], [120, 170, 240], [0, 0, 0], [240, 140, 40]], np.uint8
    )

    def as_codes(c):
        return np.where(c == WALL, 2, np.where(np.isin(c, INTERIOR), 1, 0)).astype(
            np.uint8
        )

    panels = (
        [rgb, pal[as_codes(gt_cls)]]
        + ([pal[as_codes(cnn_cls)]] if cnn_cls is not None else [])
        + [pal[our_codes]]
    )
    Image.fromarray(np.hstack(panels)).save(path)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--cache",
        type=Path,
        required=True,
        help="folder for the CubiCasa code, data and weights",
    )
    ap.add_argument("--download", action="store_true", help="download what is missing")
    ap.add_argument(
        "--device", default="auto", help="auto, cuda, mps or cpu (ROCm builds use cuda)"
    )
    ap.add_argument("--limit", type=int, default=0, help="only the first N test plans")
    ap.add_argument(
        "--tta",
        action="store_true",
        help="average 4 rotations (as in the CubiCasa paper; 4x slower)",
    )
    ap.add_argument("--ours-only", action="store_true", help="skip the CNN")
    ap.add_argument(
        "--px-per-m",
        type=float,
        default=50,
        help="assumed scale for OPTEsc on CubiCasa images (they carry none)",
    )
    ap.add_argument(
        "--pictures",
        type=int,
        default=8,
        help="save side-by-side pictures for the first N plans",
    )
    ap.add_argument(
        "--tile",
        type=int,
        default=1024,
        help="the CNN reads big plans in tiles of this many pixels; lower it if the GPU runs out of memory",
    )
    ap.add_argument(
        "--fp16",
        action="store_true",
        help="half precision on the GPU (less memory, can cost accuracy)",
    )
    ap.add_argument(
        "--restart",
        action="store_true",
        help="ignore plans already scored by an earlier run",
    )
    args = ap.parse_args()

    args.cache.mkdir(parents=True, exist_ok=True)
    code, data, weights = fetch(args.cache, args.download)
    sys.path.insert(0, str(code))
    from floortrans.loaders import FloorplanSVG

    # original_size=True: the plans at the resolution CubiCasa trained and evaluated the CNN on
    test = FloorplanSVG(str(data) + "/", "test.txt", format="txt", original_size=True)
    n = min(len(test), args.limit) if args.limit else len(test)

    model = device = None
    if not args.ours_only:
        if not weights.exists():
            sys.exit(f"No CNN weights at {weights}. Use --download, or --ours-only.")
        device = pick_device(args.device)
        print("CNN running on", describe(device))
        model = load_model(code, weights, device)

    out = args.cache / "optesc_eval"
    out.mkdir(exist_ok=True)
    m_cnn, m_ours, m_both, per_class = IoU(), IoU(), IoU(), IoU()
    t_cnn = t_ours = 0.0
    # every scored plan is saved as it finishes, so a stopped run carries on where it stopped
    done_file = (
        out / "per_plan_v3.jsonl"
    )  # v1 used shrunk plans; v3 adds the combined reader
    done = {}
    if done_file.exists() and not args.restart:
        for line in done_file.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                if r.get("cnn") is not None or args.ours_only:
                    done[r["index"]] = r
    if args.restart and done_file.exists():
        done_file.unlink()
    from PIL import Image

    for i in range(n):
        if i in done:
            r = done[i]
            for name, (a, b) in (r.get("cnn") or {}).items():
                m_cnn.add_counts(name, a, b)
            for name, (a, b) in (r.get("per_class") or {}).items():
                per_class.add_counts(name, a, b)
            for name, (a, b) in r["ours"].items():
                m_ours.add_counts(name, a, b)
            for name, (a, b) in (r.get("both") or {}).items():
                m_both.add_counts(name, a, b)
            t_cnn += r.get("t_cnn", 0)
            t_ours += r.get("t_ours", 0)
            print(f"{i + 1}/{n} {r['id']} (already scored)", flush=True)
            continue
        s = test[i]
        img = s["image"]  # 3xHxW in [-1, 1]
        gt = s["label"][0].numpy().astype(np.int64)
        rgb = (
            ((img.numpy().transpose(1, 2, 0) + 1) * 127.5).clip(0, 255).astype(np.uint8)
        )
        gt_wall, gt_room = gt == WALL, np.isin(gt, INTERIOR)
        pid = str(s["folder"]).strip("/").replace("/", "_")

        def both(p, g):
            return [int(np.logical_and(p, g).sum()), int(np.logical_or(p, g).sum())]

        rec = {
            "index": i,
            "id": pid,
            "size": [int(gt.shape[1]), int(gt.shape[0])],
            "cnn": None,
            "per_class": None,
        }
        cnn = None
        if model is not None:
            t = time.time()
            cnn, rec["ran_on"] = cnn_rooms(
                model, img, device, args.tta, args.tile, args.fp16
            )
            # what share of the plan each class covers, predicted vs true: shows at a glance if the CNN is off
            rec["share"] = {
                ROOM_CLS[c]: [
                    round(float((cnn == c).mean()), 3),
                    round(float((gt == c).mean()), 3),
                ]
                for c in range(len(ROOM_CLS))
            }
            if i == 0:
                print(
                    "  share of pixels, CNN vs truth:",
                    {k: v for k, v in rec["share"].items() if max(v) > 0.01},
                    flush=True,
                )
            rec["t_cnn"] = time.time() - t
            rec["cnn"] = {
                "wall": both(cnn == WALL, gt_wall),
                "room": both(np.isin(cnn, INTERIOR), gt_room),
            }
            rec["per_class"] = {
                name: both(cnn == c, gt == c) for c, name in enumerate(ROOM_CLS)
            }
            Image.fromarray(np.where(cnn == WALL, 0, 255).astype(np.uint8)).save(
                out / f"walls_{pid}.png"
            )

        t = time.time()
        o = ours(
            rgb, args.px_per_m * float(s.get("scale", 1))
        )  # original images are larger than the scaled ones
        rec["t_ours"] = time.time() - t
        # 'wall_with_openings' in case the labels draw walls through doors
        rec["ours"] = {
            "wall": both(o == 2, gt_wall),
            "wall_with_openings": both((o == 2) | (o == 3), gt_wall),
            "room": both(o == 1, gt_room),
        }
        if cnn is not None:  # combined: CNN walls, our doors, rooms and the rest
            ob = ours(rgb, args.px_per_m * float(s.get("scale", 1)), walls=cnn == WALL)
            rec["both"] = {
                "wall": both(ob == 2, gt_wall),
                "wall_with_openings": both((ob == 2) | (ob == 3), gt_wall),
                "room": both(ob == 1, gt_room),
            }
            for name, (a, b) in rec["both"].items():
                m_both.add_counts(name, a, b)

        for name, (a, b) in (rec["cnn"] or {}).items():
            m_cnn.add_counts(name, a, b)
        for name, (a, b) in (rec["per_class"] or {}).items():
            per_class.add_counts(name, a, b)
        for name, (a, b) in rec["ours"].items():
            m_ours.add_counts(name, a, b)
        t_cnn += rec.get("t_cnn", 0)
        t_ours += rec["t_ours"]
        with done_file.open("a") as f:
            f.write(json.dumps(rec) + "\n")

        if i < args.pictures:
            picture(out / f"compare_{pid}.png", rgb, gt, cnn, o)
        print(
            f"{i + 1}/{n} {pid} {rec['size'][0]}x{rec['size'][1]}"
            + (f" cnn on {rec['ran_on']}" if cnn is not None else ""),
            flush=True,
        )
        del cnn, o, img, gt, s

    res = {
        "plans": n,
        "tile": args.tile,
        "fp16": args.fp16,
        "original_size": True,
        "device": describe(device) if device else None,
        "tta": args.tta,
        "ours_px_per_m": args.px_per_m,
        "cnn": {
            **m_cnn.scores(),
            "per_class": per_class.scores(),
            "seconds_per_plan": round(t_cnn / n, 3),
        }
        if model
        else None,
        "ours": {**m_ours.scores(), "seconds_per_plan": round(t_ours / n, 3)},
        "combined": m_both.scores() if model else None,
    }
    (out / "results.json").write_text(json.dumps(res, indent=2))
    lines = [
        "# CubiCasa5K test set: wall and room IoU",
        "",
        f"{n} plans. CNN device: {res['device'] or 'not run'}.",
        "",
        "| Reader | Wall IoU | Room IoU | Seconds per plan |",
        "|---|---|---|---|",
    ]
    if model:
        lines.append(
            f"| CubiCasa CNN | {res['cnn']['wall']} | {res['cnn']['room']} | {res['cnn']['seconds_per_plan']} |"
        )
    if model:
        c = res["combined"]
        lines.append(
            f"| Combined: CNN walls + OPTEsc doors and rooms | {c['wall']} ({c['wall_with_openings']} counting openings as wall) | {c['room']} | - |"
        )
    lines.append(
        f"| OPTEsc rule-based reader | {res['ours']['wall']} ({res['ours']['wall_with_openings']} counting openings as wall) | {res['ours']['room']} | {res['ours']['seconds_per_plan']} |"
    )
    (out / "report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print("Saved to", out)


if __name__ == "__main__":
    main()
