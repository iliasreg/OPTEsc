"""Load an OPTEsc site JSON (exported by the Plan to 3D page) into NumPy layers.

The simulation, heatmap and camera modules all read the same grid:

    site = load_site("factory_site.json")
    site.walkable   # bool[h, w]   floor, doors and exits (outside cells excluded)
    site.wall       # bool[h, w]   walls and windows (block movement and sight)
    site.zone       # int[h, w]    0 = none, k = zone "Zk"
    site.cell_m     # metres per cell
    site.exits      # list of door dicts with is_exit = True

Cell (gx, gy): gx to the right, gy down. Metres: x = (gx + 0.5) * cell_m for a cell centre.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

CODES = {"o": 0, ".": 1, "#": 2, "D": 3, "E": 4, "W": 5}
OUTSIDE, FLOOR, WALL, DOOR, EXIT, WINDOW = range(6)


@dataclass
class Site:
    raw: dict
    kind: np.ndarray
    zone: np.ndarray
    cell_m: float
    zones: list = field(default_factory=list)
    doors: list = field(default_factory=list)

    @property
    def walkable(self) -> np.ndarray:
        return np.isin(self.kind, (FLOOR, DOOR, EXIT))

    @property
    def wall(self) -> np.ndarray:
        return np.isin(self.kind, (WALL, WINDOW))

    @property
    def exits(self) -> list:
        return [d for d in self.doors if d["is_exit"]]

    def to_cell(self, x_m: float, y_m: float) -> tuple[int, int]:
        return int(x_m // self.cell_m), int(y_m // self.cell_m)

    def to_m(self, gx: int, gy: int) -> tuple[float, float]:
        return (gx + 0.5) * self.cell_m, (gy + 0.5) * self.cell_m


def load_site(path_or_dict) -> Site:
    raw = path_or_dict if isinstance(path_or_dict, dict) else json.loads(Path(path_or_dict).read_text())
    g = raw["grid"]
    kind = np.array([[CODES[c] for c in row] for row in g["cells"]], dtype=np.uint8)
    zone = np.array(g["zone_ids"], dtype=np.int32)
    assert kind.shape == zone.shape == (g["h"], g["w"]), "grid size mismatch"
    return Site(raw=raw, kind=kind, zone=zone, cell_m=g["cell_m"], zones=raw["zones"], doors=raw["doors"])


if __name__ == "__main__":
    import sys

    s = load_site(sys.argv[1])
    print(f"{s.raw['name']}: {s.kind.shape[1]}x{s.kind.shape[0]} cells of {s.cell_m} m, "
          f"{len(s.zones)} zones, {len(s.doors)} doors, {len(s.exits)} exits, "
          f"{s.walkable.sum() * s.cell_m ** 2:.0f} m2 walkable")
