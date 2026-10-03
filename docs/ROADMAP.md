# Roadmap

Audience: homeowners. Compute: our own spark box (NVIDIA GB10, 120GB unified memory). Judgment: Claude. Pixels: spark.

The core problem with a pure image-to-image pipeline is that nothing knows where the walls are. Two views of the same room disagree, and "pan 30° right" means nothing. The plan below moves the source of truth from pixels to geometry, then lets AI do the finishing.

## Phase 0: Foundation ✅

- API server holds the Anthropic key; nothing secret in the client bundle.
- Gemini removed. Claude for reasoning and prompts, spark ComfyUI (Qwen-Image 2512 / Qwen-Image-Edit 2511 + Lightning) for images.
- Dead code removed (unused Step4Presentation, draggable card, decade-image leftovers, corrupt demo.jpg).

Still to do: persist projects (Supabase: plan, brief, renders, scenes) so a refresh doesn't lose work; a job queue with progress so the UI can show "3rd in line on spark".

## Phase 1: Architect interview ✅

- Claude-led programming interview, one question at a time, behavioral rather than abstract, with tap-to-answer replies.
- Live Design Brief (`shared/brief.ts`) feeds every later prompt.
- Architect-style pushback recorded as concerns (e.g. office with no door, bedroom against the TV wall).

Next: mood-board picks (show 6 images, ask "which feels like home?") feeding `aesthetic`; letting the brief propose 2 to 3 layout options.

## Phase 2: Plan → structured geometry ✅

- Claude reads the plan into JSON: walls (polylines with thickness), openings (doors with swing, windows with sill height), rooms (polygons, names).
- Correction editor: drag walls, add or remove openings, rename rooms.
- Scale calibration: user marks one known dimension.
- This JSON becomes the single source of truth.

## Phase 3: three.js walkthrough ✅

- react-three-fiber extrudes walls and cuts openings, with GLB furniture placed from the brief.
- Orbit and first-person walk. Viewpoints become real cameras (position, direction, FOV).
- Reuse the sitekit viewer patterns already on spark.

## Phase 4: Blender pipeline on spark ✅ (first cut)

Blender 4.0.2 with Cycles CUDA already works on spark's GB10 (verified; OptiX is not available on this arm64 build).

- A headless worker builds the scene from the plan JSON with bpy, sets the sun from site orientation, and renders Cycles beauty, depth, normal and object-ID passes from the same cameras.
- AI finishing pass: Qwen-Image-Edit restyles each Cycles render using the brief. Geometry is fixed, so every view agrees.
- Orbit and flythrough videos (same approach as the site flyovers), day/night and seasonal sun studies.
- Optional later: Wan 2.1 image-to-video (already on spark) for short living-room clips.

Done so far: `shared/scene3d.ts` is the one 3D description; `blender/render_scene.py` renders it with Cycles (CUDA on the GB10, ~15 s); scenes and fresh plan renders go Blender → Claude instruction → Qwen-Image-Edit. Next: real furniture assets instead of blocks, sun direction from the brief's orientation, orbit/flythrough video, depth/normal passes.

## Phase 5: Homeowner-grade deliverables

- Dimensioned plan, room schedule with square footage.
- Plain-language checks: bedroom egress windows, minimum room sizes, hallway and door clearances for aging in place.
- Rough cost ranges tied to the brief's splurge and save lists.
- PDF package; side-by-side Option A vs B.
