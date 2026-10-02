# Floor Plan Wizard

Upload a floor plan, get interviewed like you would by a residential architect, then get top-down renderings, eye-level interior scenes, edits, and a client presentation, all shaped by how your household actually lives.

## How it works

```
browser (Vite + React)
   │  /api/*
   ▼
API server (server/index.ts, Express)
   ├── Claude: the architect interview, reading the plan, writing image prompts, presentation copy
   └── spark ComfyUI: Qwen-Image-Edit 2511 (plan render, scene edits, add-an-object)
                      Qwen-Image 2512 (eye-level scenes), both with 8-step Lightning LoRAs
```

No API keys are shipped to the browser.

| Step | What happens |
| --- | --- |
| 1. Upload | Plan is downscaled to ≤2048px client-side. |
| 2. Interview | Claude looks at the plan and interviews the homeowner one question at a time: household, daily life, site, budget, look and feel, rooms. It flags conflicts between the plan and how they live, and keeps a live **Design Brief** (`shared/brief.ts`). Skippable. |
| 3. Render | Claude writes an edit instruction from the plan and the brief; Qwen-Image-Edit turns the plan into a top-down 3D render. Painted-mask corrections regenerate only the painted area. |
| 4. Scenes | Pick viewpoints; Claude works out what's visible from each one and writes the scene prompt; Qwen-Image renders it. |
| 5. Edit | Instruction edits, mask edits, day/night, and "add this object" (the reference photo goes to Qwen-Image-Edit as image 2). |
| 6. Presentation | Claude writes the slide copy, tied back to the brief. |

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

## Timing

Each image is one ComfyUI job on spark (about 2 minutes at 1MP with the Lightning LoRAs, longer when the model first loads or other jobs are queued). The GPU is shared with other spark workloads; jobs queue in order.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md): structured plan geometry, a three.js walkthrough, and a Blender (Cycles on spark's GB10) render pipeline for consistent, accurate views.
