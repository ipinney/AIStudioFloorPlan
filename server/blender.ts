/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
// Cycles renders of the checked geometry, from the real viewpoint cameras.
// Runs Blender headless on the same machine as this server (spark's GB10 via
// CUDA). These renders are what Qwen-Image-Edit restyles, so every view keeps
// the true layout.
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Scene3D, Vec3 } from '../shared/scene3d';

const BLENDER = process.env.BLENDER_BIN || 'blender';
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../blender/render_scene.py');
const TIMEOUT_MS = Number(process.env.BLENDER_TIMEOUT_MS || 5 * 60 * 1000);

export type Shot =
    | { name: string; kind: 'eye'; position: Vec3; target: Vec3; fov: number; width: number; height: number }
    | { name: string; kind: 'top'; width: number; height: number; frame?: { min: [number, number]; max: [number, number] } };

export interface Lighting {
    mode: 'day' | 'night';
    temperature: number;
    /** Compass direction the sun comes from, degrees clockwise from plan-up. */
    sunHeading?: number;
}

let available: Promise<boolean> | null = null;
export function blenderAvailable(): Promise<boolean> {
    available ??= new Promise(resolve => {
        const p = spawn(BLENDER, ['--version'], { stdio: 'ignore' });
        p.on('error', () => resolve(false));
        p.on('exit', code => resolve(code === 0));
    });
    return available;
}

// One Blender at a time: renders share the GPU with ComfyUI.
let queue: Promise<unknown> = Promise.resolve();

export function renderShots(scene: Scene3D, shots: Shot[], light: Lighting, samples = 96): Promise<Record<string, string>> {
    const run = queue.then(() => doRender(scene, shots, light, samples));
    queue = run.catch(() => undefined);
    return run;
}

async function doRender(scene: Scene3D, shots: Shot[], light: Lighting, samples: number): Promise<Record<string, string>> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'floorplan-'));
    try {
        const jobPath = path.join(dir, 'job.json');
        await fs.writeFile(jobPath, JSON.stringify({ scene, shots, light, samples, outDir: dir }));
        await new Promise<void>((resolve, reject) => {
            const p = spawn(BLENDER, ['-b', '--factory-startup', '-P', SCRIPT, '--', jobPath], { stdio: ['ignore', 'pipe', 'pipe'] });
            let log = '';
            p.stdout.on('data', d => { log = (log + d).slice(-4000); });
            p.stderr.on('data', d => { log = (log + d).slice(-4000); });
            const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Blender render timed out')); }, TIMEOUT_MS);
            p.on('error', err => { clearTimeout(timer); reject(err); });
            p.on('exit', code => {
                clearTimeout(timer);
                if (code === 0 && log.includes('FLOORPLAN_RENDERED')) resolve();
                else reject(new Error(`Blender failed (exit ${code}): ${log.split('\n').filter(l => /Error|Traceback/.test(l)).slice(-3).join(' ') || log.slice(-300)}`));
            });
        });
        const out: Record<string, string> = {};
        for (const shot of shots) {
            const png = await fs.readFile(path.join(dir, `${shot.name}.png`));
            out[shot.name] = `data:image/png;base64,${png.toString('base64')}`;
        }
        return out;
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
