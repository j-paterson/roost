/**
 * Inline onboarding panel — first-run "lego picker" rendered at the top of the
 * Roost Hub (NOT a modal). The Hub auto-opens on first launch; this panel walks
 * the user through the basics in-place, then collapses when setup is complete.
 *
 * Framing principle: Ollama base embeddings are the honest default and work
 * great. Fine-tuning is an advanced/BYO path. The panel never implies a
 * borrower is missing "the real system."
 */
import React, { useState } from "react";
import { deriveOnboardingSteps, type OnboardingStepId } from "@/lib/onboarding-steps";
import { INTEGRATIONS, type DetectStatus } from "@/integrations/registry";
import { Button } from "@/ui/components/ui/button";
import type { IRoostPlugin } from "@/types/plugin";

// ── Step sub-components ───────────────────────────────────────────────────────

function WelcomeStep() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Roost is a local bookmarks system: it syncs your TikTok and X saves into
        Markdown notes in your vault, then helps you organize them into a personal
        library. The core system works great with <strong>zero extra setup</strong> —
        Ollama provides local embeddings for Smart Assign out of the box.
      </p>
      <p className="text-sm text-muted-foreground">
        Optional add-ons ("legos") unlock extra capabilities like video vision,
        semantic search, or cloud AI — but you can skip them all and come back
        later. Let's walk through the basics first.
      </p>
    </div>
  );
}

function SyncFolderStep({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Where should Roost save your synced bookmarks? This is a folder path inside
        your vault (e.g. <code>Bookmarks</code>). It will be created if it doesn't
        exist.
      </p>
      <input
        type="text"
        className="w-full rounded border border-[var(--background-modifier-border)] bg-[var(--background-primary)] px-2 py-1 text-sm"
        placeholder="Bookmarks"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus
      />
    </div>
  );
}

function EmbeddingsStep({ ollamaStatus }: { ollamaStatus: DetectStatus | "unknown" }) {
  const ollamaIntegration = INTEGRATIONS.find((i) => i.id === "ollama")!;
  const sidecarIntegration = INTEGRATIONS.find((i) => i.id === "sidecar")!;

  const statusBadge =
    ollamaStatus === "available" ? (
      <span className="text-xs font-medium text-green-600">Ollama detected ✓</span>
    ) : ollamaStatus === "unavailable" ? (
      <span className="text-xs font-medium text-amber-600">Ollama not found</span>
    ) : (
      <span className="text-xs text-muted-foreground">Checking…</span>
    );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Smart Assign uses embeddings to understand your bookmarks. <strong>Ollama
        (local, free) is the recommended default — it works great.</strong> No
        account or internet connection needed.
      </p>
      <div className="flex items-center gap-2">{statusBadge}</div>
      {ollamaStatus !== "available" && (
        <div className="rounded bg-secondary p-2 text-xs text-muted-foreground">
          <strong>To install Ollama:</strong> {ollamaIntegration.setup.instructions}
        </div>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">
          Advanced: fine-tuned embeddings (optional, power-users only)
        </summary>
        <div className="mt-2 rounded bg-secondary p-2">
          Power users can train a fine-tuned model on their own labeled bookmarks
          for higher accuracy on their specific collections — most people don't need
          this. {sidecarIntegration.setup.instructions}
        </div>
      </details>
    </div>
  );
}

function LlmStep({
  llmBackend,
  anthropicApiKey,
  onBackendChange,
  onKeyChange,
}: {
  llmBackend: string;
  anthropicApiKey: string;
  onBackendChange: (v: string) => void;
  onKeyChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Roost can use a local Ollama chat model for AI features (LLM rerank,
        pipelines) — no account needed. Or provide an Anthropic API key to use
        Claude instead. You can also skip AI features entirely.
      </p>
      <div className="flex flex-col gap-2">
        {(["local", "cloud", "skip"] as const).map((v) => (
          <label key={v} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="roost-onboarding-llm"
              value={v}
              checked={llmBackend === v}
              onChange={() => onBackendChange(v)}
            />
            {v === "local" && "Local (Ollama) — recommended"}
            {v === "cloud" && "Cloud (Anthropic Claude)"}
            {v === "skip" && "Skip AI features for now"}
          </label>
        ))}
      </div>
      {llmBackend === "cloud" && (
        <input
          type="password"
          className="w-full rounded border border-[var(--background-modifier-border)] bg-[var(--background-primary)] px-2 py-1 text-sm"
          placeholder="Anthropic API key (sk-ant-…)"
          value={anthropicApiKey}
          onChange={(e) => onKeyChange(e.target.value)}
        />
      )}
    </div>
  );
}

function OptionalLegosStep() {
  // Non-ollama, non-sidecar legos as optional add-ons. Sidecar is covered in the
  // embeddings step as an advanced/BYO option.
  const optionalLegos = INTEGRATIONS.filter((i) => i.id !== "ollama" && i.id !== "sidecar");
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        These optional add-ons unlock extra capabilities. All are safe to skip —
        you can enable them any time from the Integrations section below.
      </p>
      {optionalLegos.map((lego) => (
        <div key={lego.id} className="rounded border border-border p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{lego.label}</span>
            <span className="text-xs text-muted-foreground">optional</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{lego.unlocks}</p>
          <details className="mt-1">
            <summary className="cursor-pointer select-none text-xs text-[var(--text-faint)]">
              Setup instructions
            </summary>
            <p className="mt-1 text-xs text-muted-foreground">{lego.setup.instructions}</p>
          </details>
        </div>
      ))}
    </div>
  );
}

function DoneStep() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        You're all set! Roost is ready to use. Connect a platform below to sync your
        first bookmarks and start organizing.
      </p>
      <p className="text-xs text-muted-foreground">
        You can re-run this setup anytime via the command palette ("Re-run
        first-time setup").
      </p>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

const STEP_IDS: OnboardingStepId[] = [
  "welcome",
  "sync-folder",
  "embeddings",
  "llm",
  "optional-legos",
  "done",
];

/**
 * Inline onboarding stepper. Renders nothing until the parent decides to show it
 * (gated on !settings.setupComplete). `onComplete` is called on Finish or Skip —
 * the parent flips setupComplete and stops rendering the panel.
 */
export function OnboardingPanel({
  plugin,
  onComplete,
}: {
  plugin: IRoostPlugin;
  onComplete: () => void;
}) {
  const settings = plugin.settings;
  const [stepIndex, setStepIndex] = useState(0);
  const [syncFolder, setSyncFolder] = useState(settings.syncFolder || "Bookmarks");
  const [llmBackend, setLlmBackend] = useState<string>(settings.llmBackend || "local");
  const [anthropicApiKey, setAnthropicApiKey] = useState(settings.anthropicApiKey || "");
  const ollamaStatus = plugin.integrationStatus.ollama;

  const steps = deriveOnboardingSteps({ syncFolder, llmBackend });
  const currentStepId = STEP_IDS[stepIndex];
  const currentStep = steps.find((s) => s.id === currentStepId)!;
  const isLast = stepIndex === STEP_IDS.length - 1;
  const isFirst = stepIndex === 0;

  const finish = async () => {
    settings.syncFolder = syncFolder.trim() || "Bookmarks";
    settings.llmBackend = llmBackend as "local" | "cloud" | "skip";
    settings.anthropicApiKey = anthropicApiKey;
    settings.setupComplete = true;
    await plugin.saveSettings();
    onComplete();
  };

  const handleNext = () => {
    if (isLast) void finish();
    else setStepIndex((i) => i + 1);
  };
  const handleBack = () => { if (!isFirst) setStepIndex((i) => i - 1); };
  const handleStepSkip = () => { if (!isLast) setStepIndex((i) => i + 1); };

  return (
    <div className="mx-4 mt-3 mb-1 rounded-lg border border-border bg-secondary/40 overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-3">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
          First-time setup · Step {stepIndex + 1} of {STEP_IDS.length}
        </div>
        {/* Skip the whole flow — marks setup complete so it won't nag; re-run
            available from the command palette. */}
        <button
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void finish()}
          title="Skip setup — you can re-run it anytime from the command palette"
        >
          Skip setup
        </button>
      </div>

      <div className="px-4 pt-1 text-sm font-semibold">{currentStep.title}</div>

      <div className="mx-4 mt-2 h-1 rounded bg-[var(--background-modifier-border)]">
        <div
          className="h-1 rounded bg-[var(--interactive-accent)]"
          style={{ width: `${((stepIndex + 1) / STEP_IDS.length) * 100}%` }}
        />
      </div>

      <div className="px-4 py-3 min-h-[120px]">
        {currentStepId === "welcome" && <WelcomeStep />}
        {currentStepId === "sync-folder" && (
          <SyncFolderStep value={syncFolder} onChange={setSyncFolder} />
        )}
        {currentStepId === "embeddings" && <EmbeddingsStep ollamaStatus={ollamaStatus} />}
        {currentStepId === "llm" && (
          <LlmStep
            llmBackend={llmBackend}
            anthropicApiKey={anthropicApiKey}
            onBackendChange={setLlmBackend}
            onKeyChange={setAnthropicApiKey}
          />
        )}
        {currentStepId === "optional-legos" && <OptionalLegosStep />}
        {currentStepId === "done" && <DoneStep />}
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-t border-border">
        <div className="flex gap-2">
          {!isFirst && (
            <Button size="sm" variant="secondary" onClick={handleBack}>Back</Button>
          )}
          {!isLast && !isFirst && (
            <button
              className="text-sm px-2 text-muted-foreground hover:text-foreground"
              onClick={handleStepSkip}
            >
              Skip
            </button>
          )}
        </div>
        <Button size="sm" onClick={handleNext}>{isLast ? "Finish" : "Next"}</Button>
      </div>
    </div>
  );
}
