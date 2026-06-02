#!/bin/bash
# Overnight batch: Phase F (fine-tune with hard negatives) → Phase B (LLM rerank).
# Sequential. Ollama models unloaded before Phase F to free unified memory for MPS.
set -u

LOG=/tmp/overnight-$(date +%Y%m%d-%H%M).log
VENV=~/ObsidianBookmarks/.roost/venv/bin/python

echo "===== OVERNIGHT BATCH =====" | tee -a "$LOG"
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
        # `ollama stop` unloads a model; if it isn't installed as a CLI,
        # set keep_alive=0 via the generate API to force unload.
        curl -s -X POST http://localhost:11434/api/generate \
            -d "{\"model\":\"$m\",\"prompt\":\"\",\"keep_alive\":0}" > /dev/null 2>&1
    done
    sleep 3
fi
STILL_LOADED=$(curl -s http://localhost:11434/api/ps | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(m['name'] for m in d.get('models',[])))" 2>/dev/null || echo "")
echo "After unload: ${STILL_LOADED:-<none>}" | tee -a "$LOG"
echo "Free RAM:" | tee -a "$LOG"
vm_stat | awk '/free/ {print "  free pages:",$3}' | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "===== Phase F: fine-tune with hard negatives =====" | tee -a "$LOG"
echo "Start: $(date)" | tee -a "$LOG"
"$VENV" scripts/finetune-hard-neg.py 2>&1 | tee -a "$LOG"
PHASE_F_EXIT=${PIPESTATUS[0]}
echo "Phase F exit: $PHASE_F_EXIT" | tee -a "$LOG"
echo "End:   $(date)" | tee -a "$LOG"

# Give the system a moment to release MPS memory before loading LLMs
sleep 5

echo "" | tee -a "$LOG"
echo "===== Phase B: LLM rerank at K=3 =====" | tee -a "$LOG"
echo "Start: $(date)" | tee -a "$LOG"
"$VENV" scripts/llm-rerank-sweep.py 2>&1 | tee -a "$LOG"
PHASE_B_EXIT=${PIPESTATUS[0]}
echo "Phase B exit: $PHASE_B_EXIT" | tee -a "$LOG"
echo "End:   $(date)" | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "===== DONE =====" | tee -a "$LOG"
echo "Finish: $(date)" | tee -a "$LOG"
echo "Phase F exit: $PHASE_F_EXIT" | tee -a "$LOG"
echo "Phase B exit: $PHASE_B_EXIT" | tee -a "$LOG"
