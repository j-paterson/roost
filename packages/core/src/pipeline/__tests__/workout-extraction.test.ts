/**
 * Workouts pipeline extraction unit tests.
 *
 * Tests that the LLM JSON → WorkoutExtraction parse step formats exercises
 * as readable strings ("Push-ups — 3x10") rather than {name, reps} objects,
 * so they YAML-stringify cleanly in note frontmatter.
 *
 * Mirrors the pattern in recipe-extraction-recovery.test.ts (mocked ollamaGenerate).
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  extractWorkout,
  type WorkoutCandidate,
} from "@/pipeline/workouts-pipeline";
import { TFile } from "obsidian";
import {
  __setRequestUrlImpl,
  __resetRequestUrlImpl,
} from "obsidian";

function candidate(partial: Partial<WorkoutCandidate> = {}): WorkoutCandidate {
  return {
    roostId: "tiktok:w1",
    file: new TFile() as TFile,
    title: "Full body HIIT workout",
    subtitle: "",
    description: "",
    vision: "",
    tags: ["hiitworkout"],
    author: "",
    authorHandle: "",
    url: "",
    suggestWords: [],
    ...partial,
  };
}

function mockOllama(response: string) {
  __setRequestUrlImpl(async () => ({
    status: 200,
    json: { response },
    text: "",
  }));
}

describe("extractWorkout — exercises as readable strings", () => {
  afterEach(() => __resetRequestUrlImpl());

  it("formats exercises with reps as 'name — reps' strings", async () => {
    const json = JSON.stringify({
      workoutType: "strength",
      name: "Push & Pull Superset",
      targetArea: "upper body",
      exercises: [
        { name: "Push-ups", reps: "3x10" },
        { name: "Pull-ups", reps: "3x8" },
      ],
      duration: "30 min",
      difficulty: "intermediate",
      equipment: ["pull-up bar"],
      notes: null,
    });
    mockOllama(json);
    const result = await extractWorkout(candidate({ description: "push pull workout" }));

    expect(result).not.toBeNull();
    expect(result!.exercises).toEqual(["Push-ups — 3x10", "Pull-ups — 3x8"]);
  });

  it("formats exercise with null reps as bare name string", async () => {
    const json = JSON.stringify({
      workoutType: "yoga",
      name: "Morning Flow",
      targetArea: "full body",
      exercises: [
        { name: "Downward Dog", reps: null },
        { name: "Warrior II", reps: "30 seconds" },
      ],
      duration: null,
      difficulty: "beginner",
      equipment: ["mat"],
      notes: null,
    });
    mockOllama(json);
    const result = await extractWorkout(candidate({ description: "yoga flow" }));

    expect(result).not.toBeNull();
    expect(result!.exercises).toEqual(["Downward Dog", "Warrior II — 30 seconds"]);
  });

  it("returns null when name is unknown", async () => {
    const json = JSON.stringify({
      workoutType: "other",
      name: "unknown",
      targetArea: "",
      exercises: [],
      duration: null,
      difficulty: "intermediate",
      equipment: [],
      notes: null,
    });
    mockOllama(json);
    const result = await extractWorkout(candidate({ description: "some content" }));
    expect(result).toBeNull();
  });

  it("drops exercises with empty name", async () => {
    const json = JSON.stringify({
      workoutType: "cardio",
      name: "HIIT Blast",
      targetArea: "full body",
      exercises: [
        { name: "Jumping Jacks", reps: "1 min" },
        { name: "", reps: "10" },
        { name: "Burpees", reps: null },
      ],
      duration: "20 min",
      difficulty: "intermediate",
      equipment: [],
      notes: null,
    });
    mockOllama(json);
    const result = await extractWorkout(candidate({ description: "hiit routine" }));

    expect(result).not.toBeNull();
    expect(result!.exercises).toEqual(["Jumping Jacks — 1 min", "Burpees"]);
  });
});
