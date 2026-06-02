/**
 * Side-effect imports — each module registers its view with the registry
 * at load time. main.ts imports this file once at plugin onload; the
 * registry is then queryable via getPipelineGalleryView.
 *
 * Adding a new pipeline view: create src/views/pipeline-views/<id>.ts
 * that calls registerPipelineGalleryView, then add it to this index.
 */
import "./media-list";
import "./places-map";

export { getPipelineGalleryView, type PipelineGalleryView, type PipelineGalleryHandle } from "./registry";
