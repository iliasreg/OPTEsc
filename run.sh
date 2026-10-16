#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec "${PYTHON:-python3}" tools/drill_rag.py --port "${1:-8767}"
