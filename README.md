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
