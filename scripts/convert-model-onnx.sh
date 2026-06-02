#!/usr/bin/env bash
# Convert the fine-tuned nomic model to ONNX for the WASM/JS embedder.
# Requires: optimum, onnxruntime installed in the sidecar venv.
set -euo pipefail

VAULT="${VAULT:?Set VAULT to your vault path}"
VENV="$VAULT/.roost/venv/bin"
MODEL_DIR="$VAULT/.roost/build/nomic-finetuned-hardneg"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/models/nomic-finetuned-onnx"

if [ ! -d "$MODEL_DIR" ]; then
  echo "Model not found at $MODEL_DIR"
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "=== Step 1: Export to ONNX ==="
"$VENV/optimum-cli" export onnx \
  --model "$MODEL_DIR" \
  --task feature-extraction \
  --trust-remote-code \
  "$OUT_DIR"

echo ""
echo "=== Step 2: Quantize to uint8 ==="
"$VENV/python" -c "
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic(
    '$OUT_DIR/model.onnx',
    '$OUT_DIR/model_quantized.onnx',
    weight_type=QuantType.QUInt8,
)
print('Quantized model written')
"

# Replace fp32 with quantized
mv "$OUT_DIR/model_quantized.onnx" "$OUT_DIR/model.onnx"

echo ""
echo "=== Done ==="
ls -lh "$OUT_DIR"
