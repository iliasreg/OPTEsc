# OPTEsc: Plan to measured building model (F1) and fire drill (F4)

Open a floor plan in the browser and get a measured building: walls, rooms with net areas, doors with clear width and swing direction, exits, windows, the room-and-door graph, exit travel distances, a list of things to check, an explorable 3D model and an IFC file that opens in BIM tools. Then start a fire anywhere and watch the building empty: flames, a smoke layer that comes down from the ceiling, and every person finding their way out.


The plan reader and simulation run locally in the browser (CPU). The optional drill-guidance prototype below uses a local server and opt-in AMD cloud inference.

## English drill guidance — French reference corpus

Run `./run.sh` from the repository, then open http://localhost:8767. Python 3.10+ is sufficient; the guidance service uses only the standard library. Use `./run.sh 9000` for another port, or set `PYTHON` to your conda environment's Python executable.

The server reads `API_KEY` from `~/.amd.env`. Defaults: `AMD_BASE_URL=https://developer.amd.com.cn/radeon/api/v1`, `AMD_MODEL=Qwen3.8-27B`. Environment variables or values in that file override the defaults. Never put the key in frontend code. The server binds to localhost only.

1. Keep the default DXF sample loaded and click **Run fire drill** in the top bar. The compact sidebar shows one section at a time: **Setup**, **Details** or **View**. Setup contains drill parameters, collapsed building/import controls and guidance/audio settings; Details contains checks, results, room measurements and exports; View contains camera and plan-editing controls.
2. Watch subtitles inside the scene: the fire's room, room smoke and blocked doors update with playback. There is no instruction request button.
3. Source-backed instructions appear automatically beneath the simulated facts, with citations. Optional cloud inference can select phrases but never delays the initial subtitle.
4. **Read aloud** speaks the displayed subtitle only when clicked; speech availability depends on the browser.

Subtitles follow the simulation clock, including seeking backwards. A blocked-door notice uses the simulation's fire exclusion rule, not queues or a language-model guess. These are simulated events, not sensor readings. Changing or closing the drill clears stale guidance. The company plan is bound to the sample's grid, room identifiers and doors; other buildings receive factual simulation notices without this fictional company's instructions.

This is a bounded lexical RAG: retrieve indexed French legal/INRS summaries and fictional company-plan sections, then ask Qwen to select supported action IDs. Server-side checks render only fixed draft phrases with stored citations; the model cannot write routes, invent exits, or suppress required reminders. The panel distinguishes real model selection from deterministic fallback. The provider can take tens of seconds; requests time out after 60 seconds. Missing evidence produces no advice.

Cloud requests contain the event zone/scenario and relevant excerpts, not the floorplan geometry or credentials. Cloud inference is off by default; local source-backed subtitles remain automatic. No embeddings, vector database or model download is needed.

- [Fictional factory emergency plan](docs/safety/factory-emergency-plan.md)
- [French sources, measurements, scope and reuse limits](docs/safety/french-sources.md)
- `data/rag/`: source metadata, searchable summaries, action bank and sample binding.
- Offline tests: `python3 -m unittest discover -s tests -p 'test_drill_rag.py'` and `node --test tests/sim.test.mjs tests/drillguidance.test.mjs`.

Not an approved emergency system or a French compliance assessment. Existing geometry warnings still use the application's UK/NFPA heuristics; this feature does not replace them with a French compliance engine. The sample's shutter exit and inward-opening exit remain unresolved. No real assembly location, accessibility route or staff role has been verified. A qualified site review is required before real-world use.


## Run locally

```bash
cd frontend && python3 -m http.server 8765   # open http://localhost:8765
```

The sample factory opens as a DXF. **Upload plan** takes DXF, PDF, PNG/JPG, a saved site JSON, or any IFC file (shown with web-ifc).

## Inputs, best first

| Input | Scale | Room names and printed areas |
|---|---|---|
| **DXF** | exact, from `$INSUNITS` (guessed from size if missing, and flagged) | from TEXT/MTEXT |
| **PDF** (vector) | from a "1:NNN" note on the drawing | from the PDF text layer |
| **Image** (PNG, JPG, WebP) | found automatically: from the room sizes printed on the plan, else from door widths, else from wall thickness (each flagged). You can still type the width or press **Set scale from this room** | read from the image text in the browser (OCR, see below) |

DXF reader (`vector.js`): LINE, LWPOLYLINE (with arcs), POLYLINE, ARC, CIRCLE, TEXT, MTEXT, HATCH and block INSERTs. Layers whose name contains wall/mur/wand/muro/parete (e.g. `A-WALL`) are walls; closed wall outlines are filled. PDF pages are rendered with pdf.js and text is masked out so letters are not read as door leaves.

## What it measures (`plan2grid.js`, `analyze.js`)

- **Rooms**: net floor area (walls subtracted to sub-cell precision), compared with the printed area when there is one.
- **Doors**: clear width measured on the wall pixels, swing side and hinge from the drawn leaf and arc, with a confidence. Openings over 1.2 m with no leaf are read as part of the room (and flagged when they join two named rooms).
- **Exits**: doors and wide openings to the outside.
- **Egress**: walking distance from every point to the nearest exit (no corner cutting), worst point per room.
- **Checks** (critical / warning / info, each pinned in 3D): no door, no exit route, travel distance over the limit (45 m default, UK ADB; NFPA 101 allows 61 or 76 m depending on use), door under 0.8 m clear (NFPA 101 7.2.1.2.3), exit door opening inwards (NFPA 101 7.2.1.4.2), swing not found, rooms merged through an opening, area far from the printed area, small rooms, guessed units, scale typed by hand, door or window unclear.

Nothing is guessed silently: when the reader is unsure it says so in the checks list.

## Outputs

- **3D view** (three.js): extruded walls, door leaves and swing arcs on the floor, zone colours or an exit-distance heatmap, issue pins, walk-through mode.
- **Fix plan** tab: paint walls, erase false walls, paint a door across an opening.
- **Site JSON** for the simulation layers (grid, zones, doors with swing, exits, graph, egress, issues).
- **IFC4** (`ifc.js`): IfcWall, IfcDoor (with OperationType from the hinge side, roller doors for wide exits), IfcWindow, IfcSpace with NetFloorArea, `Pset_DoorCommon.FireExit`, and OPTEsc property sets. **Open export in web-ifc** re-reads the file with an independent IFC engine and shows it.

## Site JSON (contract with the other layers)

```jsonc
{
  "source": { "kind": "dxf", "scale_known": true, "px_per_m": 60 },
  "grid": { "cell_m": 0.1, "w": 430, "h": 270, "cells": ["oo###..."], "zone_ids": [[0,1,...]] },  // o . # D E W
  "zones": [{ "id": "Z2", "name": "Office A", "type": "office", "area_m2": 46.5, "printed_area_m2": 46.7,
              "centroid": [x, y], "polygon": [[x, y], ...] }],
  "doors": [{ "id": "D2", "x": 6.65, "y": 6.1, "width_m": 0.9, "along": "y", "connects": ["Z5", "Z6"], "is_exit": false,
              "swing": { "into": "Z6", "toward": "+x", "hinge": [6.65, 5.65], "confidence": 1 } }],
  "openings": [{ "between": ["Z3", "Z4"], "length_m": 2.4 }],   // open-plan rooms split by their names
  "exits": ["D1"], "graph": { "nodes": [], "edges": [] },   // edges through an opening carry "open": true
  "egress": { "limit_m": 45, "max_travel_m": 38.2, "zones": { "Z2": { "max_m": 12.1, "worst": [x, y] } } },
  "issues": [{ "severity": "warning", "code": "exit-swings-in", "message": "...", "target": "D10", "at": [x, y] }]
}
```

Metres from the grid's top-left corner, x right, y down (three.js x → x, y → z; IFC Y = −y). `backend/plan/site.py` loads it into NumPy for the simulation.

## Reading images (`ocr.js`)

An image has no text layer, so the page reads the printed text itself with Tesseract (tesseract.js, in a web worker, nothing uploaded). It finds room names (English plus common Swedish, French, German, Spanish and Italian words), sizes under them (feet and inches like `11'2" x 10'11"`, metres, centimetres, m², sq ft) and sizes printed with no readable name. The strip under each name is read a second time as a single line of size characters, because the first, sparse reading often breaks sizes apart.

Each label becomes a hint `{name, type, x, y, printedArea}` in image pixels. Names then shape the rooms: a zone that holds two or more names (an open-plan kitchen and dining room) is split along the shortest straight line between corners that keeps each name in its own room, or else by walking distance from each name. The parts stay joined by an **opening** (`site.openings`, and `open: true` edges in the graph), which counts as a way in for the no-door check.

The scale is then set from the median of all rooms whose size was printed (a printed area that covers an open-plan group is compared with the whole group). With no sizes it falls back to door widths (about 0.9 m per opening), and with no doors to a 0.2 m wall thickness; both are flagged as estimates. Hints can also be passed in by hand or by a vision model later (see `SAMPLES.png` in `main.js`).

## AI wall finder (optional, on your GPU)

Walls are where a drawing-based reader struggles most (furniture, hatching, thin inner walls). `tools/wall_server.py` runs the CubiCasa5K network on this computer, on the GPU when there is one (NVIDIA CUDA, AMD ROCm build of PyTorch, Apple MPS, else CPU), and the page uses its walls for image plans. Everything else (doors and swing, room names, scale, exits, checks) still comes from the plan itself. Without the service, walls come from the drawing as before.

```bash
python tools/cubicasa_eval.py --cache ./cubicasa_cache --download --limit 1   # once: code and weights
python tools/wall_server.py --cache ./cubicasa_cache                         # keep it running
```

The page finds it at `http://localhost:8766` (or `?walls=http://host:port` in the page URL), shows "Walls from the AI wall finder" under Detection settings, and records `source.walls_from: "ai"` in the site JSON. The plan is read at a few sizes and the size the network is most sure about is used. The CubiCasa weights are CC BY-NC 4.0 (non-commercial).

`tools/cubicasa_eval.py` scores three readers on the CubiCasa5K test set: the CNN alone, our reader alone, and the combination. `eval/run_eval.mjs --walls http://localhost:8766` scores the page with the service running.

## Fire drill (`sim.js`, `simview.js`, `simui.js`)

Pick the room the fire starts in (or **Pick spot** and click the floor), then **Run fire drill**. **Find worst fire** starts a fire in every room with the same people and ranks them, worst first.

- **People** are placed by how busy each room type usually is (one person per 25 m² of production floor, 10 m² of office, 5 m² of canteen or lockers, one per bedroom...; see `DENSITY`), or type a total. Each reacts after 10 to 60 s (a third of that in the room on fire, or at once when smoke or flames reach them).
- **Fire** spreads over the floor at 2, 5 or 10 cm/s and is held 3 minutes by each closed door. **Smoke** runs ahead at 0.5 m/s under the ceiling, is held 15 s by doors, and fills each room over a time that grows with its size.
- **Walking**: everyone takes the quickest way out, re-planned every 2 s around flames and smoke. Speed falls in crowds (Weidmann 1993) and in smoke. Doors let through at most 1.3 people per second per metre of width (SFPE), which is where queues form. Breathing thick smoke for 90 s overcomes a person.
- **Results**: time until everyone is out and 95% out, people overcome or trapped, and for each room when it is empty versus when its smoke gets thick (the spare time; red when people are still inside). Also the doors where people queued and how many used each exit. The playback shows waiting people in grey, moving in blue, overcome in red, no way out in amber.

The model is deliberately simple and fast (a factory runs in about a second in the browser). It is for comparing layouts, exits and fire starts, not a certified fire engineering analysis. Tests: `node --test tests/sim.test.mjs`.

## How well it works

`eval/RESULTS.md` has the latest numbers and where it fails. To re-run:

```bash
cd frontend && python3 -m http.server 8765 &
cd eval && npm i && node run_eval.mjs        # pip install ifcopenshell for the second IFC check
```

The CubiCasa5K wall and room IoU check runs on your own PC, on the GPU when there is one (NVIDIA CUDA, AMD ROCm or Apple MPS, else CPU):

```bash
python tools/cubicasa_eval.py --cache ~/cubicasa --download --limit 50
```

It scores both the CubiCasa CNN and OPTEsc's own reader (`tools/plan2grid_cli.mjs` runs the browser code in Node), and saves the CNN's wall mask for each plan as a clean image the page can open.

## Licences and reuse

- **three.js** (MIT), **pdf.js** (Apache-2.0), **web-ifc** (MPL-2.0) and **tesseract.js** with its WebAssembly core (Apache-2.0) are vendored unmodified in `frontend/vendor/` with their licences. The English text model `eng.traineddata` (tessdata_best, integer) is Apache-2.0 from the Tesseract project.
- **FloorplanToBlender3d** is GPL-3.0 and **PlanX3D** copies it; no code from either is used. Their example plans are downloaded by the evaluation at run time and not stored here.
- **CubiCasa5K** data and model weights are CC BY-NC 4.0 (non-commercial). They are downloaded by `tools/cubicasa_eval.py` into a folder you choose and never committed. A commercial product would need its own training data.
- The sample factory is synthetic, drawn by `tools/make_sample_plan.py` with exact truth in `data/samples/factory_truth.json`.
