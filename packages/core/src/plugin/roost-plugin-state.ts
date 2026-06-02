/**
 * Listener buses for RoostPlugin — filter, mode, log, and related UI events.
 */
import type { RoostFilter, ItemClickData, RoostMode } from "@/types/roost";

type Unsubscribe = () => void;

class ValueBus<T> {
  private listeners = new Set<(value: T) => void>();

  constructor(private _value: T) {}

  get value(): T {
    return this._value;
  }

  set(value: T): void {
    this._value = value;
    for (const fn of this.listeners) fn(value);
  }

  subscribe(fn: (value: T) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

class FlagBus {
  private listeners = new Set<(value: boolean) => void>();

  constructor(private _value: boolean) {}

  get value(): boolean {
    return this._value;
  }

  set(value: boolean): void {
    if (this._value === value) return;
    this._value = value;
    for (const fn of this.listeners) fn(value);
  }

  subscribe(fn: (value: boolean) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

class EventBus<T> {
  private listeners = new Set<(payload: T) => void>();

  subscribe(fn: (payload: T) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  emit(payload: T): void {
    for (const fn of this.listeners) fn(payload);
  }
}

class VoidEventBus {
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): Unsubscribe {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Mutable plugin event surface — owned by RoostPlugin, public API unchanged. */
export class RoostPluginState {
  readonly filter = new ValueBus<RoostFilter>(null);
  readonly mode = new ValueBus<RoostMode>(null);
  readonly explorerPaths = new ValueBus<string[]>([]);
  readonly bulkWrite = new FlagBus(false);
  readonly itemClick = new EventBus<ItemClickData>();
  readonly dataRefresh = new VoidEventBus();
  readonly log = new EventBus<string>();
}
