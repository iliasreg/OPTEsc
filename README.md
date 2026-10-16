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

Open **http://localhost:8767** and click **Run drill**. The sample factory loads automatically.

Use `./run.sh 9000` for another port. Stop the server with `Ctrl+C`.

## Use

- **Setup** — choose Fire or Earthquake, choose the fire’s starting room, or open a DXF plan. Other simulation settings use their defaults.
- **Results** — drill summary and room results only.
- **View** — switch between 3D and plan editing. One disabled Export button reserves the final export workflow; it is not implemented yet.

Subtitles identify simulated fire, smoke and blocked doors during playback and highlight the named room or door. Instructions include source references and update when you rewind.

Furniture, machines and stairs are read from the DXF by layer or block name (AIA, French, German and other conventions) and stairs also by their evenly spaced treads. People walk round furniture. The default demo treats this as the ground floor. The underlying simulator also supports upper-floor stairs and assistance arrangements.

**Fire** uses a two-zone smoke model with the NZ Verification Method C/VM2 design fire, detectors and sprinklers, and checks each room against the C/VM2 tenability limits at 2 m (visibility, ISO 13571 doses). Occupants react after the C/VM2 pre-travel time for the building use, faster with a voice alarm, and move at SFPE speeds through doors of limited capacity. Older people and people with a walking aid or a wheelchair are slower (Boyce et al. 1999); wheelchairs cannot pass doors under 0.75 m.

**Earthquake** damage follows HAZUS (FEMA) for the chosen structure and seismic design: the building's damage state, collapse and casualties come from its fragility curves and casualty rates; falling walls, rubble and jammed doors illustrate that state on the plan.

The underlying simulator supports repeated-run safety checks; the simplified workspace shows a single drill summary and its rooms.

Method, sources, verification and limits: [docs/simulation-method.md](docs/simulation-method.md). Earthquake and fire subtitles separate simulation facts from cited action phrases.

Plan import is **DXF-only** (`.dxf`, case-insensitive), through both the file picker and drag-and-drop. PDF, images, IFC and saved Site JSON are rejected before reading. The old export controls are no longer exposed; the final Export button is reserved for a later implementation. Plan reading and simulation run locally in the browser; raster OCR and AI wall detection are not used. Imported geometry, scale and inferred exits still require review before running a drill.

The sample drill uses D9 only; it excludes the loading shutter D1 and the unresolved exit D11. Imported or edited geometry needs a site-specific exit policy before a drill can run. The sample policy does not certify any real exit.

During playback, the exterior dims more than the building. Pausing, finishing or closing the drill restores the original bright view. Larger surface signs use four cached particle frames per sign style, switched at most once every 125 ms, without extra particle meshes or post-processing. Motion stops while paused or hidden and respects reduced-motion preferences.

Projected guidance is a visual concept: floor arrows, crossed-door warnings and short lintel messages follow the simulated hazards and D9-only policy. Projected drill signs are enabled by default. Arrows disappear when no route stays below the demo smoke threshold; this threshold is not a real-world safety standard. No projectors or sensors are connected, and the rendering does not predict optical visibility through smoke or replace required signage.

The fictional extinguisher near D9 has four simple wall-projected pictograms: pull pin, aim low, squeeze, sweep. Click the equipment in the scene to face the wall; there is no separate button, floating card or popup. The general USFA PASS and INRS training references remain in the source and assets; the Setup training section is no longer shown. This does not replace hands-on training, the unit’s label or site procedures. The training steps remain visible during software drills; they are not an instruction to interrupt evacuation.

Earthquake projections recalculate when walls collapse, furniture topples or doors jam. They avoid all current rubble and blocked cells, withdraw if no clear route remains, and restore on rewind. Evacuation arrows stay hidden during shaking and aftershocks. They do not certify a real route or direct anyone through collapsed walls.

Earthquake subtitles also use the cited English phrase bank: shelter during shaking, conditional site-led movement after shaking, and renewed protection during aftershocks. Phase changes override subtitle holds and support rewind. French official guidance comes from the Préfecture des Hautes-Alpes, paired with the fictional factory plan; simulation damage does not certify usable exits or rubble crossings.

## AI guidance

AI instruction selection is enabled by default. Immediate cited local phrases remain available while a request runs or if the provider is unavailable. Configure the AMD-hosted model with a key in `~/.amd.env`:

```dotenv
API_KEY=your_api_key
```

No UI toggle is needed. The default model is `Qwen3.8-27B`; `AMD_MODEL` and `AMD_BASE_URL` can override the provider settings.

The key stays server-side. Cloud requests contain the event’s zone, scenario and source excerpts—not the full floor plan. The model cannot invent routes or exits.

English instructions draw on [French safety references](docs/safety/french-sources.md) and a [fictional factory plan](docs/safety/factory-emergency-plan.md). Company-specific instructions apply only to the matching sample; they are not approved procedures for other buildings.

## Tests

Requires Node.js 20+ for the JavaScript tests.

```bash
python3 -m unittest discover -s tests -p 'test_drill_rag.py'
node --test tests/*.test.mjs
```

`node tools/make_test_plans.mjs tests/fixtures` regenerates the five test plans (different layer conventions) used to check that objects and stairs are found on any drawing.

## License

[MIT](LICENSE). Bundled libraries retain their own licenses in [`frontend/vendor/`](frontend/vendor/). Optional CubiCasa5K data and model weights have non-commercial terms and are not required for the demo.
