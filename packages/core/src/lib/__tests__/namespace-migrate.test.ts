// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renameNamespacesInFrontmatter } from "../namespace-migrate";

describe("renameNamespacesInFrontmatter (pure)", () => {
  it("renames pipeline_v_media → enrichment_v_mediaExtraction", () => {
    const result = renameNamespacesInFrontmatter({ pipeline_v_media: 2, other: "x" });
    expect(result.updated).toEqual({ enrichment_v_mediaExtraction: 2, other: "x" });
    expect(result.renamed).toBe(1);
  });

  it("renames enrichment_v_media → enrichment_v_mediaFiles", () => {
    const result = renameNamespacesInFrontmatter({ enrichment_v_media: 5 });
    expect(result.updated).toEqual({ enrichment_v_mediaFiles: 5 });
    expect(result.renamed).toBe(1);
  });

  it("renames both fields independently when both present", () => {
    const result = renameNamespacesInFrontmatter({
      pipeline_v_media: 2,
      enrichment_v_media: 1,
    });
    expect(result.updated).toEqual({
      enrichment_v_mediaExtraction: 2,
      enrichment_v_mediaFiles: 1,
    });
    expect(result.renamed).toBe(2);
  });

  it("returns renamed=0 when no legacy fields present", () => {
    const result = renameNamespacesInFrontmatter({ enrichment_v_mediaExtraction: 3 });
    expect(result.renamed).toBe(0);
    expect(result.updated).toEqual({ enrichment_v_mediaExtraction: 3 });
  });

  it("does not overwrite an existing canonical field with a legacy value", () => {
    const result = renameNamespacesInFrontmatter({
      pipeline_v_media: 2,
      enrichment_v_mediaExtraction: 3,
    });
    expect(result.updated).toEqual({ enrichment_v_mediaExtraction: 3 });
    expect(result.renamed).toBe(1);
  });
});
