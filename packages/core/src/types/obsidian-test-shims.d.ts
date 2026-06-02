/**
 * Type augmentation for the test-only exports in src/__mocks__/obsidian.ts.
 *
 * Vitest aliases `import { ... } from "obsidian"` to the mock file at
 * runtime (see vitest.config.ts). This declaration makes TypeScript see
 * the same test-only exports without modifying the real obsidian package's
 * type definitions.
 *
 * The leading `import "obsidian"` is critical — it makes this file a module
 * augmentation rather than a module redeclaration. Without it, TS would
 * shadow the real obsidian types instead of extending them.
 */
import "obsidian";

declare module "obsidian" {
  /** Test-only hook — install a stub for `requestUrl()` in unit tests. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function __setRequestUrlImpl(impl: (req: any) => Promise<any>): void;
  /** Test-only hook — restore the default throwing implementation. */
  export function __resetRequestUrlImpl(): void;

  /**
   * The mock at src/__mocks__/obsidian.ts:7-10 exposes `basePath` as a public
   * field for test setup. The real obsidian package only exposes
   * `getBasePath()`, so this declaration matches the mock's shape and lets
   * tests configure the adapter without going through a method call.
   */
  interface FileSystemAdapter {
    basePath: string;
  }
}
