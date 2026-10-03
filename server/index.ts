/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
// API server: holds the Anthropic key, talks to spark's ComfyUI, and serves the
// built frontend in production. Run with `npm run server` (dev) or `npm start`.
import express, { type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as claude from './claude';
import { comfyHealth, editImage, textToImage } from './comfy';
import { describeView, layoutToText, metersPerPixel, roomAt, type PlanGeometry } from '../shared/geometry';
import { buildScene, cameraFor, defaultHeading } from '../shared/scene3d';
import { blenderAvailable, renderShots } from './blender';

const app = express();
app.use(express.json({ limit: '60mb' }));

const route = (handler: (body: any) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
        res.json(await handler(req.body ?? {}));
    } catch (error) {
        console.error(`${req.path} failed:`, error);
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
};

app.get('/api/health', async (_req, res) => {
    res.json({ ok: true, comfy: await comfyHealth(), blender: await blenderAvailable(), claude: Boolean(process.env.ANTHROPIC_API_KEY) });
});

app.post('/api/interview', route(body =>
    claude.interviewTurn({ planImage: body.planImage, history: body.history ?? [], brief: body.brief ?? null, language: body.language ?? 'en' })));

// Plan → top-down rendering. Without a mask the whole plan is re-rendered;
// with one only the painted area changes.
app.post('/api/render-plan', route(async body => {
    const count = Math.min(Math.max(Number(body.count) || 1, 1), 4);
    const geometry: PlanGeometry | null = body.geometry ?? null;

    // With checked geometry, a fresh render starts from an exact Cycles top view
    // framed to the uploaded plan, so rooms cannot drift.
    if (geometry && !body.instruction && !body.mask && await blenderAvailable()) {
        const mpp = metersPerPixel(geometry);
        const { width: W, height: H } = geometry.image;
        const scale = Math.sqrt(1_300_000 / (W * H));
        const shot = {
            name: 'top', kind: 'top' as const,
            width: Math.round((W * scale) / 16) * 16, height: Math.round((H * scale) / 16) * 16,
            frame: { min: [0, 0] as [number, number], max: [W * mpp, H * mpp] as [number, number] },
        };
        const { top } = await renderShots(buildScene(geometry), [shot], { mode: 'day', temperature: 5500 }, 64);
        const prompt = await claude.finishRenderPrompt({
            render: top, kind: 'top', style: body.brief?.aesthetic?.style ?? '', brief: body.brief ?? null,
            layout: layoutToText(geometry), mode: 'day', temperature: 5500,
        });
        const images: string[] = [];
        for (let i = 0; i < count; i++) images.push(await editImage({ image: top, instruction: prompt }));
        return { images, prompt, base: top };
    }

    const prompt = await claude.planRenderingPrompt(body.image, body.brief ?? null, body.instruction, geometry ? layoutToText(geometry) : undefined);
    const images: string[] = [];
    // Sequential: the GPU runs one job at a time anyway, and this keeps the queue fair.
    for (let i = 0; i < count; i++) {
        images.push(await editImage({ image: body.image, instruction: prompt, mask: body.mask }));
    }
    return { images, prompt };
}));

app.post('/api/geometry', route(async body => ({
    geometry: await claude.extractGeometry(body.gridImage, Number(body.width), Number(body.height)),
})));

app.post('/api/scene', route(async body => {
    const geometry: PlanGeometry | null = body.geometry ?? null;
    const camera = body.camera ?? { rotation: 0, tilt: 0, zoom: 1 };
    const mode = body.mode ?? 'day', temperature = body.temperature ?? 5500;
    // Aim: the homeowner's drag, else toward the far side of the room; then the modal's pan.
    const heading = geometry && body.planPoint
        ? Number(body.heading ?? defaultHeading(geometry, body.planPoint, roomAt(geometry.rooms, body.planPoint))) + Number(camera.rotation ?? 0)
        : 0;
    const viewFacts = geometry && body.planPoint ? describeView(geometry, body.planPoint, heading) : undefined;

    // With geometry: render the true view in Blender, then restyle it with Qwen-Image-Edit.
    if (geometry && body.planPoint && await blenderAvailable()) {
        const fov = Math.min(100, Math.max(35, 75 / Math.max(0.5, Number(camera.zoom) || 1)));
        const cam = cameraFor(geometry, {
            u: body.planPoint.x / geometry.image.width, v: body.planPoint.y / geometry.image.height, heading,
        }, fov, Number(camera.tilt) || 0);
        const { view } = await renderShots(buildScene(geometry), [{ name: 'view', kind: 'eye', ...cam, width: 1344, height: 768 }], { mode, temperature });
        const prompt = await claude.finishRenderPrompt({
            render: view, kind: 'eye', style: body.style ?? '', brief: body.brief ?? null, viewFacts, mode, temperature,
        });
        return { image: await editImage({ image: view, instruction: prompt }), prompt, base: view };
    }

    // Without geometry: Claude imagines the view from the marked plan.
    const prompt = await claude.scenePrompt({
        viewFacts,
        markedPlan: body.markedPlan, viewIndex: body.viewIndex, brief: body.brief ?? null, style: body.style ?? '',
        camera: body.camera ?? { rotation: 0, tilt: 0, zoom: 1 }, mode: body.mode ?? 'day', temperature: body.temperature ?? 5500,
    });
    return { image: await textToImage(prompt, 1344, 768), prompt };
}));

app.post('/api/edit-scene', route(async body => {
    const prompt = await claude.editPrompt({
        scene: body.image, instruction: body.instruction ?? '', mode: body.mode ?? 'day', temperature: body.temperature ?? 5500,
        objectImage: body.objectImage, masked: Boolean(body.mask),
    });
    return { image: await editImage({ image: body.image, instruction: prompt, mask: body.mask, reference: body.objectImage }), prompt };
}));

app.post('/api/suggest-style', route(async body => ({ style: await claude.suggestStyle(body.planImage, body.brief ?? null) })));
app.post('/api/style-ideas', route(async body => ({ styles: await claude.suggestStyleIdeas(body.brief ?? null) })));
app.post('/api/suggest-improvement', route(async body => ({ suggestion: await claude.suggestPlanImprovement(body.planImage, body.brief ?? null) })));
app.post('/api/presentation', route(body =>
    claude.presentationText({ planImage: body.planImage, sceneImages: body.sceneImages ?? [], style: body.style ?? '', brief: body.brief ?? null, language: body.language ?? 'en' })));

// Production: serve the Vite build from the same origin.
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
app.use(express.static(dist));
app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));

const port = Number(process.env.PORT || 8790);
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`FloorPlan API on http://${host}:${port}`));
