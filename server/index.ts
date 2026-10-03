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
import { describeView, layoutToText, type PlanGeometry } from '../shared/geometry';

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
    res.json({ ok: true, comfy: await comfyHealth(), claude: Boolean(process.env.ANTHROPIC_API_KEY) });
});

app.post('/api/interview', route(body =>
    claude.interviewTurn({ planImage: body.planImage, history: body.history ?? [], brief: body.brief ?? null, language: body.language ?? 'en' })));

// Plan → top-down rendering. Without a mask the whole plan is re-rendered;
// with one only the painted area changes.
app.post('/api/render-plan', route(async body => {
    const count = Math.min(Math.max(Number(body.count) || 1, 1), 4);
    const geometry: PlanGeometry | null = body.geometry ?? null;
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
    // With checked geometry and a viewpoint in plan pixels, state the view as measured facts.
    const geometry: PlanGeometry | null = body.geometry ?? null;
    const viewFacts = geometry && body.planPoint
        ? describeView(geometry, body.planPoint, Number(body.heading ?? 0) + Number(body.camera?.rotation ?? 0))
        : undefined;
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
