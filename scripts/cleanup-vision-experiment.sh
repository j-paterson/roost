#!/usr/bin/env bash
# Cleanup for the 2026-06-20 uncensored vision-captioner bake-off.
#
# This session downloaded several LARGE models purely to EVALUATE which captioner
# best describes explicit content for embedding enrichment. None are wired into the
# plugin — they were experiment-only. Run this to reclaim the disk when done.
#
# Review before running: `bash scripts/cleanup-vision-experiment.sh`         (dry-run: lists sizes)
#                        `bash scripts/cleanup-vision-experiment.sh --apply`  (actually removes)
#
# ⚠️ KEEPS the live uncensored pipeline — do NOT remove these:
#   - Ollama models in normal use: minicpm-v, gemma4:e4b, llama3.2, the embedders
#   - The Marqo NSFW image classifier (Marqo/nsfw-image-detection-384) + `timm`/`Pillow`
#     in .roost/build/venv — that powers the SHIPPED /classify-uncensored sidecar endpoint.

set -u
APPLY="${1:-}"
HF_HUB="${HF_HOME:-$HOME/.cache/huggingface}/hub"

echo "=== Experiment artifacts (remove these) ==="

# 1) Ollama: the abliterated VLM pulled for the head-to-head (~6GB)
OLLAMA_MODELS=(
  "huihui_ai/qwen2.5-vl-abliterated:latest"
)

# 2) HuggingFace model caches downloaded by the bake-off subagent (~16-17GB each)
HF_MODELS=(
  "models--fancyfeast--llama-joycaption-beta-one-hf-llava"   # JoyCaption
  "models--Minthy--ToriiGate-v0.4-7B"                        # ToriiGate
)

echo "--- Ollama ---"
for m in "${OLLAMA_MODELS[@]}"; do
  if ollama list 2>/dev/null | grep -q "${m%%:*}"; then
    echo "  present: $m"
    [ "$APPLY" = "--apply" ] && ollama rm "$m" && echo "    removed."
  else
    echo "  (absent: $m)"
  fi
done

echo "--- HuggingFace cache ($HF_HUB) ---"
for m in "${HF_MODELS[@]}"; do
  d="$HF_HUB/$m"
  if [ -d "$d" ]; then
    echo "  $(du -sh "$d" 2>/dev/null | cut -f1)  $d"
    [ "$APPLY" = "--apply" ] && rm -rf "$d" && echo "    removed."
  else
    echo "  (absent: $m)"
  fi
done

echo
echo "=== Optional (review by hand — installed into the DEV venv .roost/venv) ==="
echo "  pip packages added for the experiment: transformers, accelerate, sentencepiece, mlx-vlm, timm"
echo "  (the spike's timm lives here too). Safe to uninstall if .roost/venv isn't used elsewhere:"
echo "    .roost/venv/bin/python3 -m pip uninstall -y transformers accelerate mlx-vlm"
echo "  NOTE: do NOT touch .roost/build/venv — that timm/Pillow runs the live sidecar."
echo
[ "$APPLY" != "--apply" ] && echo "Dry-run only. Re-run with --apply to remove the experiment models above."
