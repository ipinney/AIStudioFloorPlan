# Floor Plan Wizard

Upload a floor plan, get interviewed like you would by a residential architect, then get top-down renderings, eye-level interior scenes, edits, and a client presentation, all shaped by how your household actually lives.

## How it works

```
browser (Vite + React + three.js)
   │  /api/*
   ▼
API server (server/index.ts, Express), runs on spark
   ├── Claude: architect interview, reading the plan into geometry,
   │           image instructions, presentation copy
   ├── Blender 4 / Cycles (CUDA on the GB10): true eye-level and top-down
   │           renders of the checked geometry
   └── ComfyUI: Qwen-Image-Edit 2511 restyles those renders (and does mask
               edits / add-an-object); Qwen-Image 2512 only as a no-geometry fallback
```

No API keys are shipped to the browser.

| Step | What happens |
| --- | --- |
| 1. Upload | Plan is downscaled to ≤2048px client-side. |
| 2. Interview | Claude interviews the homeowner like an architect (household, daily life, site, budget, look and feel, rooms), flags plan/lifestyle conflicts, and keeps a live **Design Brief** (`shared/brief.ts`). Skippable. |
| 3. Layout | Claude reads the plan (with a labelled pixel grid drawn on it) into walls, doors, windows, rooms and furniture (`shared/geometry.ts`). The homeowner fixes it in an SVG editor and sets the scale from a known length. Skippable, but it is what keeps rooms in place. |
| 4. Render | With a layout: an exact Cycles top view framed to the plan, restyled by Qwen-Image-Edit. Without: Qwen-Image-Edit straight from the plan. Mask corrections regenerate only the painted area. |
| 5. Scenes | Place and aim viewpoints on the plan, or walk the 3D model (`components/Walkthrough3D.tsx`) and drop them at eye level. With a layout each view is a real Cycles render from that camera, then restyled; the same `shared/scene3d.ts` description drives three.js and Blender, so every view agrees. |
| 6. Edit | Instruction edits, mask edits, day/night, "add this object" (reference photo as image 2). |
| 7. Presentation | Claude writes the slide copy, tied back to the brief. |

## Run locally

Prerequisites: Node 22+, an Anthropic API key, and network access to spark's ComfyUI.

```bash
npm install
cp .env.example .env.local   # set ANTHROPIC_API_KEY and COMFY_URL
npm run dev                  # API on :8790 + Vite on :5173 (proxied /api)
```

ComfyUI on spark listens on `127.0.0.1:8188` only. Either run this server on spark, or tunnel:

```bash
ssh -N -L 8188:127.0.0.1:8188 eliot@spark-2f53
```

Production: `npm run build && npm start` serves the built app and the API from one process.

`GET /api/health` reports whether ComfyUI is reachable and a Claude key is set.

## Deploy (spark)

Runs as the systemd user unit `floorplan.service` on spark, bound to the Tailscale address only: `http://100.101.34.117:8790`. Put `ANTHROPIC_API_KEY` in `~/floorplan/.env.local`, then `scripts/deploy-spark.sh` pulls, builds and restarts. `GET /api/health` reports ComfyUI, Blender and the Claude key.

## Hosted preview (Vercel)

The frontend is deployed as the Vercel project `floorplan-wizard` (https://floorplan-wizard-ivan-pinneys-projects.vercel.app). It is a static build with `VITE_API_BASE=https://spark.barrioenergy.com/floorplan`; Vultr's nginx forwards `/floorplan/` to the spark API over Tailscale.

Access is a shared password: spark's API rejects every call without `Authorization: Bearer $APP_PASSWORD` (set in `~/floorplan/.env.local` on spark), and the app asks for it once per browser. `CORS_ORIGIN_PATTERN` there allows the Vercel origins. To change the password, edit `.env.local` and restart `floorplan.service`.

## Timing (spark GB10)

- Blender/Cycles: about 15 s for a few shots at 64 samples.
- Qwen-Image-Edit with the model warm: 30 to 50 s per image.
- Switching between Qwen-Image-Edit and Qwen-Image costs about 3.5 minutes: ComfyUI runs with `--disable-fast-disk` and spark has ~28 GB RAM free, so a switch rereads 20 GB from disk. The geometry path only uses Qwen-Image-Edit, which avoids this.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md): structured plan geometry, a three.js walkthrough, and a Blender (Cycles on spark's GB10) render pipeline for consistent, accurate views.
