"""AI wall finder for the OPTEsc page, running on this computer.

The page (frontend/) sends an image plan here and gets back a wall mask drawn by the CubiCasa5K
network on your GPU (NVIDIA CUDA, AMD ROCm build of PyTorch, Apple MPS, else CPU). The page then
finds doors, room names, scale and exits from the plan itself, as before. Without this service
running, the page reads walls from the drawing.

Setup: the same as tools/cubicasa_eval.py (it uses the code and weights that script downloads).
    python tools/wall_server.py --cache ./cubicasa_cache            # then open the page as usual
    python tools/wall_server.py --cache ./cubicasa_cache --port 8766 --device cpu

Licence: the CubiCasa5K weights are CC BY-NC 4.0, so this is for non-commercial use.

API:
    GET  /health  -> {"device": "...", "model": "cubicasa5k"}
    POST /walls   body: PNG/JPEG image -> PNG of the same size, white = wall or window
                  headers X-Device (where it ran) and X-Scale (the size it was read at)
"""

import argparse
import io
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from cubicasa_eval import WALL, describe, load_model, pick_device  # noqa: E402

WINDOW_ICON = 1  # CubiCasa icon classes: 0 none, 1 window, 2 door, ...
# CubiCasa plans are mostly 500 to 1300 px across; a plan is read at a few sizes in that range
# and the size the network is most sure about wins
SIDES = (640, 900, 1250)


def predict(model, device, rgb, sides, tile=1024):
    """rgb: HxWx3 uint8. Returns (wall mask HxW bool, chosen long side, mean confidence)."""
    import torch
    import torch.nn.functional as F

    h, w = rgb.shape[:2]
    x0 = torch.from_numpy(rgb).permute(2, 0, 1).float().unsqueeze(0) / 127.5 - 1
    best = None
    for side in sides:
        k = side / max(h, w)
        sh, sw = max(64, round(h * k)), max(64, round(w * k))
        if sh > 2 * tile or sw > 2 * tile:
            continue
        x = F.interpolate(x0, size=(sh, sw), mode="area" if k < 1 else "bilinear").to(
            device
        )
        with torch.inference_mode():
            pred = model(x).float()
            pred = F.interpolate(
                pred, size=(sh, sw), mode="bilinear", align_corners=True
            )
            rooms = torch.softmax(pred[:, 21:33], 1)
            icons = torch.softmax(pred[:, 33:44], 1)
            conf = float(rooms.max(1).values.mean())
            wall = (rooms.argmax(1) == WALL) | (icons.argmax(1) == WINDOW_ICON)
        if best is None or conf > best[2]:
            best = (wall[0].cpu().numpy(), side, conf)
        del x, pred, rooms, icons
        if device.type == "cuda":
            torch.cuda.empty_cache()
    from PIL import Image

    mask = Image.fromarray(best[0].astype(np.uint8) * 255).resize((w, h), Image.NEAREST)
    return np.array(mask) > 127, best[1], best[2]


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--cache",
        type=Path,
        required=True,
        help="the folder tools/cubicasa_eval.py downloaded into",
    )
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument(
        "--device", default="auto", help="auto, cuda, mps or cpu (ROCm builds use cuda)"
    )
    args = ap.parse_args()

    import torch
    from PIL import Image

    code, weights = (
        args.cache / "CubiCasa5k",
        args.cache / "model_best_val_loss_var.pkl",
    )
    if not code.exists() or not weights.exists():
        sys.exit(
            f"No CNN weights at {weights}. Run: python tools/cubicasa_eval.py --cache {args.cache} --download --limit 1"
        )
    device = pick_device(args.device)
    model = load_model(code, weights, device)
    where = describe(device)
    lock = Lock()  # one plan at a time on the GPU

    class Handler(BaseHTTPRequestHandler):
        def cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header(
                "Access-Control-Allow-Private-Network", "true"
            )  # pages served over https
            self.send_header(
                "Access-Control-Expose-Headers", "X-Device, X-Scale, X-Confidence"
            )

        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.end_headers()

        def do_GET(self):
            if self.path.rstrip("/") != "/health":
                return self.send_error(404)
            body = json.dumps({"device": where, "model": "cubicasa5k"}).encode()
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path.rstrip("/") != "/walls":
                return self.send_error(404)
            try:
                data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                rgb = np.array(Image.open(io.BytesIO(data)).convert("RGB"))
                t = time.time()
                with lock:
                    try:
                        wall, side, conf = predict(model, device, rgb, SIDES)
                        ran = where
                    except RuntimeError as e:
                        if "out of memory" not in str(e):
                            raise
                        torch.cuda.empty_cache()
                        model.to("cpu")
                        wall, side, conf = predict(
                            model, torch.device("cpu"), rgb, SIDES
                        )
                        model.to(device)
                        ran = "CPU (GPU out of memory)"
                buf = io.BytesIO()
                Image.fromarray(wall.astype(np.uint8) * 255).save(buf, "PNG")
                print(
                    f"{rgb.shape[1]}x{rgb.shape[0]} read at {side} px, confidence {conf:.2f}, {time.time() - t:.2f} s on {ran}",
                    flush=True,
                )
                self.send_response(200)
                self.cors()
                self.send_header("Content-Type", "image/png")
                self.send_header("X-Device", ran)
                self.send_header("X-Scale", f"{side / max(rgb.shape[:2]):.3f}")
                self.send_header("X-Confidence", f"{conf:.3f}")
                self.end_headers()
                self.wfile.write(buf.getvalue())
            except Exception as e:  # noqa: BLE001
                self.send_response(500)
                self.cors()
                self.end_headers()
                self.wfile.write(str(e).encode())

        def log_message(self, *a):
            pass

    print(
        f"AI wall finder on {where}, listening on http://localhost:{args.port}. Open the OPTEsc page and upload a plan."
    )
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
