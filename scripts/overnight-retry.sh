#!/bin/bash
# Retry: Phase F (fine-tune, OOM fix: max_seq=256 + batch=4)
#     → Phase B gemma4-only rerun (think: false fix)
# Sequential. Ollama models unloaded before Phase F to free unified memory for MPS.
set -u

LOG=/tmp/retry-$(date +%Y%m%d-%H%M).log
VENV=~/ObsidianBookmarks/.roost/venv/bin/python

echo "===== RETRY BATCH =====" | tee -a "$LOG"
echo "Start: $(date)" | tee -a "$LOG"
echo "Log:   $LOG" | tee -a "$LOG"

# --- Pre-flight: unload ALL Ollama models to free memory for MPS training ---
echo "" | tee -a "$LOG"
echo "===== Pre-flight: unloading Ollama models =====" | tee -a "$LOG"
LOADED=$(curl -s http://localhost:11434/api/ps | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(m['name'] for m in d.get('models',[])))" 2>/dev/null || echo "")
echo "Currently loaded: ${LOADED:-<none>}" | tee -a "$LOG"
if [ -n "$LOADED" ]; then
    for m in $LOADED; do
        echo "Stopping $m..." | tee -a "$LOG"
        curl -s -X POST http://localhost:11434/api/generate \
            -d "{\"model\":\"$m\",\"prompt\":\"\",\"keep_alive\":0}" > /dev/null 2>&1
    done
    sleep 3
fi
STILL_LOADED=$(curl -s http://localhost:11434/api/ps | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(m['name'] for m in d.get('models',[])))" 2>/dev/null || echo "")
echo "After unload: ${STILL_LOADED:-<none>}" | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "===== Phase F: fine-tune with hard negatives (max_seq=256, batch=4) =====" | tee -a "$LOG"
echo "Start: $(date)" | tee -a "$LOG"
"$VENV" scripts/finetune-hard-neg.py 2>&1 | tee -a "$LOG"
PHASE_F_EXIT=${PIPESTATUS[0]}
echo "Phase F exit: $PHASE_F_EXIT" | tee -a "$LOG"
echo "End:   $(date)" | tee -a "$LOG"

# Let MPS release memory before hitting Ollama
sleep 5

echo "" | tee -a "$LOG"
echo "===== Phase B: gemma4 rerun (think: false fix) =====" | tee -a "$LOG"
echo "Start: $(date)" | tee -a "$LOG"
"$VENV" scripts/llm-rerank-sweep.py --models=gemma4:e4b 2>&1 | tee -a "$LOG"
PHASE_B_EXIT=${PIPESTATUS[0]}
echo "Phase B exit: $PHASE_B_EXIT" | tee -a "$LOG"
echo "End:   $(date)" | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "===== DONE =====" | tee -a "$LOG"
echo "Finish: $(date)" | tee -a "$LOG"
echo "Phase F exit: $PHASE_F_EXIT" | tee -a "$LOG"
echo "Phase B exit: $PHASE_B_EXIT" | tee -a "$LOG"
