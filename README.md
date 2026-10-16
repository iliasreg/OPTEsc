# OPTEsc

Turn a floor plan into an interactive 3D building, run a fire drill, and follow short, source-backed instructions as the scene changes.

A software prototype—not a live emergency system or a building-compliance assessment.

## Run

Requires Python 3.12+, Bash and a modern browser. No GPU, model download or API key is needed for the default demo.

```bash
git clone https://github.com/iliasreg/OPTEsc.git
cd OPTEsc
./run.sh
```

Open **http://localhost:8767** and click **Run fire drill**. The sample factory loads automatically.

Use `./run.sh 9000` for another port. Stop the server with `Ctrl+C`.

## Use

- **Setup** — choose the fire location and occupant count, import a plan, or enable optional audio and cloud guidance.
- **Details** — inspect building checks, drill results and room measurements; export Site JSON or IFC.
- **View** — orbit, walk through the building or edit the plan.

Subtitles identify simulated fire, smoke and blocked doors during playback and highlight the named room or door. Instructions include source references and update when you rewind.

Plan import is **DXF-only** (`.dxf`, case-insensitive), through both the file picker and drag-and-drop. PDF, images, IFC and saved Site JSON are rejected before reading. Site JSON and IFC exports remain available, including the IFC export preview. Plan reading and simulation run locally in the browser; raster OCR and AI wall detection are not used. Imported geometry, scale and inferred exits still require review before running a drill.

The sample drill uses D9 only; it excludes the loading shutter D1 and the unresolved exit D11. Imported or edited geometry needs a site-specific exit policy before a drill can run. The sample policy does not certify any real exit.

During playback, the exterior dims more than the building. Pausing, finishing or closing the drill restores the original bright view. Larger surface signs use four cached particle frames per sign style, switched at most once every 125 ms, without extra particle meshes or post-processing. Motion stops while paused or hidden and respects reduced-motion preferences.

Projected guidance is a visual concept: floor arrows, crossed-door warnings and short lintel messages follow the simulated hazards and D9-only policy. Toggle **View → Projected drill signs**. Arrows disappear when no route stays below the demo smoke threshold; this threshold is not a real-world safety standard. No projectors or sensors are connected, and the rendering does not predict optical visibility through smoke or replace required signage.

The fictional extinguisher near D9 has four simple wall-projected pictograms: pull pin, aim low, squeeze, sweep. Click the equipment in the scene to face the wall; there is no separate button, floating card or popup. The projection follows the same visibility toggle as the floor arrows. General USFA PASS guidance and INRS training context are linked in Setup. This does not replace hands-on training, the unit’s label or site procedures. The training steps remain visible during software drills; they are not an instruction to interrupt evacuation.

## Optional AI guidance

The demo uses fixed, cited phrases by default. To let an AMD-hosted model select relevant phrases, add your key to `~/.amd.env`:

```dotenv
API_KEY=your_api_key
```

Then enable cloud inference under **Setup → Guidance & audio**. The default model is `Qwen3.8-27B`; `AMD_MODEL` and `AMD_BASE_URL` can override the provider settings.

The key stays server-side. Cloud requests contain the event’s zone, scenario and source excerpts—not the full floor plan. The model cannot invent routes or exits.

English instructions draw on [French safety references](docs/safety/french-sources.md) and a [fictional factory plan](docs/safety/factory-emergency-plan.md). Company-specific instructions apply only to the matching sample; they are not approved procedures for other buildings.

## Tests

Requires Node.js 20+ for the JavaScript tests.

```bash
python3 -m unittest discover -s tests -p 'test_drill_rag.py'
node --test tests/*.test.mjs
```

## License

[MIT](LICENSE). Bundled libraries retain their own licenses in [`frontend/vendor/`](frontend/vendor/). Optional CubiCasa5K data and model weights have non-commercial terms and are not required for the demo.
