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

Subtitles identify simulated fire, smoke and blocked doors during playback. Instructions include source references and update when you rewind.

DXF, PDF and image plans are supported, along with saved Site JSON. Plan reading and simulation run locally in the browser. Imported geometry and inferred exits require review.

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
node --test tests/sim.test.mjs tests/drillguidance.test.mjs
```

## License

[MIT](LICENSE). Bundled libraries retain their own licenses in [`frontend/vendor/`](frontend/vendor/). Optional CubiCasa5K data and model weights have non-commercial terms and are not required for the demo.
