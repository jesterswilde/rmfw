# Phase 3 Notes

- WGSL buffers still assume the old single-channel layout; shader structs and bindings need to be updated once the new Render/Transforms channels are wired into the renderer.
- OpsChannel / child-buffer packing remains deferred; the current RenderChannel only captures per-entity metadata plus parent indices. Future work should add the CSR-style op packing described in the roadmap before enabling boolean tree evaluation on the GPU.
- No automated coverage exists yet for the implicit root MIN remapping beyond the updated RenderChannel unit tests. Integration-level tests exercising multi-root render trees would increase confidence.
- Bridge specs are still hard-coded; migrating to the declarative spec/registration flow described in the roadmap is pending.
