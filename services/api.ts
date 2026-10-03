/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
// Browser-side client for the FloorPlan API server (server/index.ts).
// No API keys live in the browser: Claude and spark's ComfyUI are called server-side.
import type { GeneratedScene } from '../components/Step3SceneGeneration';
import type { Language } from '../lib/i18n';
import type { DesignBrief, InterviewMessage, InterviewTurn } from '../shared/brief';
import type { PlanGeometry } from '../shared/geometry';

// The design brief from the interview step. App keeps this in sync so every
// generation call is grounded in how the household actually lives.
let activeBrief: DesignBrief | null = null;
export function setActiveBrief(brief: DesignBrief | null) {
    activeBrief = brief;
}

// The checked plan geometry, once the homeowner has confirmed it.
let activeGeometry: PlanGeometry | null = null;
export function setActiveGeometry(geometry: PlanGeometry | null) {
    activeGeometry = geometry;
}

// Where the API lives. Empty = same origin (spark, or the Vite dev proxy); the
// Vercel build points this at the spark API published through Vultr.
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';
const PASSWORD_KEY = 'floorplan-password';

export function getPassword(): string {
    try { return localStorage.getItem(PASSWORD_KEY) ?? ''; } catch { return ''; }
}
export function setPassword(value: string) {
    try { localStorage.setItem(PASSWORD_KEY, value); } catch { /* private mode: session only */ }
    sessionPassword = value;
}
let sessionPassword = getPassword();

/** Fired when the API rejects the password, so the app can show the gate again. */
export const AUTH_REQUIRED_EVENT = 'floorplan-auth-required';

async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}/api/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionPassword}` },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data as T;
}

/** True when the API accepts the given password. */
export async function checkPassword(value: string): Promise<boolean> {
    const res = await fetch(`${API_BASE}/api/auth`, { method: 'POST', headers: { Authorization: `Bearer ${value}` } });
    return res.ok;
}

/** Any image source (URL or data URL) → PNG/JPEG data URL. */
export async function toDataUrl(src: string): Promise<string> {
    if (src.startsWith('data:')) return src;
    const blob = await (await fetch(src)).blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

const maskToDataUrl = (maskBase64?: string) => maskBase64 ? `data:image/png;base64,${maskBase64}` : undefined;

// --- Interview ---------------------------------------------------------------

export async function interviewTurn(
    planImage: string,
    history: InterviewMessage[],
    brief: DesignBrief | null,
    language: Language
): Promise<InterviewTurn> {
    return post('interview', { planImage: await toDataUrl(planImage), history, brief, language });
}

// --- Plan geometry -------------------------------------------------------------

/** Draws a labelled pixel grid over the plan so Claude can read coordinates precisely. */
async function gridOverlay(planImageSrc: string): Promise<{ image: string; width: number; height: number }> {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = planImageSrc; });
    const width = img.naturalWidth, height = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');
    ctx.drawImage(img, 0, 0);
    const step = Math.max(50, Math.round(Math.max(width, height) / 20 / 50) * 50);
    ctx.font = `${Math.max(11, Math.round(step / 5))}px sans-serif`;
    for (let x = 0; x <= width; x += step) {
        ctx.strokeStyle = x % (step * 2) === 0 ? 'rgba(0, 120, 255, 0.45)' : 'rgba(0, 120, 255, 0.2)';
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
        ctx.fillStyle = 'rgba(0, 90, 220, 0.9)';
        ctx.fillText(String(x), x + 2, 12);
    }
    for (let y = 0; y <= height; y += step) {
        ctx.strokeStyle = y % (step * 2) === 0 ? 'rgba(0, 120, 255, 0.45)' : 'rgba(0, 120, 255, 0.2)';
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
        ctx.fillStyle = 'rgba(0, 90, 220, 0.9)';
        ctx.fillText(String(y), 2, y - 2);
    }
    return { image: canvas.toDataURL('image/jpeg', 0.9), width, height };
}

export async function extractPlanGeometry(planImageSrc: string): Promise<PlanGeometry> {
    const grid = await gridOverlay(await toDataUrl(planImageSrc));
    const { geometry } = await post<{ geometry: PlanGeometry }>('geometry', { gridImage: grid.image, width: grid.width, height: grid.height });
    return geometry;
}

// --- Plan rendering ----------------------------------------------------------

/**
 * Renders the plan top-down. `instruction` describes a change; with a mask only
 * the painted area is regenerated.
 */
export async function generateAIRendering(
    baseImageSrc: string,
    instruction?: string,
    maskBase64?: string,
    numberOfImages: number = 1
): Promise<string[]> {
    const { images } = await post<{ images: string[] }>('render-plan', {
        image: await toDataUrl(baseImageSrc),
        instruction,
        mask: maskToDataUrl(maskBase64),
        count: numberOfImages,
        brief: activeBrief,
        geometry: activeGeometry,
    });
    return images;
}

export async function suggestPlanImprovements(planImageSrc: string): Promise<string> {
    const { suggestion } = await post<{ suggestion: string }>('suggest-improvement', { planImage: await toDataUrl(planImageSrc), brief: activeBrief });
    return suggestion;
}

// --- Interior scenes ---------------------------------------------------------

/** Draws the numbered viewpoint marker onto the plan so Claude can see where the camera stands. */
async function markViewpoint(planImageSrc: string, pointX: number, pointY: number, viewIndex: number): Promise<string> {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = planImageSrc;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');
    ctx.drawImage(img, 0, 0);
    ctx.beginPath();
    ctx.arc(pointX, pointY, 25, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(255, 0, 0, 0.8)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.font = 'bold 20px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(viewIndex.toString(), pointX, pointY);
    return canvas.toDataURL('image/png');
}

export async function generateInteriorScene(
    planImageSrc: string,
    pointX: number,
    pointY: number,
    style: string,
    viewIndex: number,
    camera: { rotation: number; tilt: number; zoom: number; },
    mode: 'day' | 'night',
    temperature: number,
    viewpoint?: { u: number; v: number; heading?: number }
): Promise<string> {
    const markedPlan = await markViewpoint(planImageSrc, pointX, pointY, viewIndex);
    const planPoint = activeGeometry && viewpoint
        ? { x: viewpoint.u * activeGeometry.image.width, y: viewpoint.v * activeGeometry.image.height }
        : undefined;
    const { image } = await post<{ image: string }>('scene', {
        markedPlan, viewIndex, style, camera, mode, temperature, brief: activeBrief,
        geometry: planPoint ? activeGeometry : undefined, planPoint, heading: viewpoint?.heading,
    });
    return image;
}

export async function editInteriorScene(
    baseImageSrc: string,
    prompt: string,
    mode: 'day' | 'night',
    temperature: number,
    maskBase64?: string,
    objectImage?: string
): Promise<string> {
    const { image } = await post<{ image: string }>('edit-scene', {
        image: await toDataUrl(baseImageSrc),
        instruction: prompt,
        mode,
        temperature,
        mask: maskToDataUrl(maskBase64),
        objectImage: objectImage ? await toDataUrl(objectImage) : undefined,
    });
    return image;
}

export async function suggestInteriorStyle(planImageSrc: string): Promise<string> {
    if (activeBrief?.aesthetic.style) return activeBrief.aesthetic.style;
    const { style } = await post<{ style: string }>('suggest-style', { planImage: await toDataUrl(planImageSrc), brief: activeBrief });
    return style;
}

export async function suggestStyleIdeas(): Promise<string[]> {
    try {
        const { styles } = await post<{ styles: string[] }>('style-ideas', { brief: activeBrief });
        if (styles.length) return styles;
    } catch (error) {
        console.error('Error suggesting style ideas:', error);
    }
    return ['Modern Minimalist', 'Scandinavian', 'Industrial Loft', 'Bohemian Chic', 'Coastal', 'Japanese Zen'];
}

// --- Presentation ------------------------------------------------------------

export interface PresentationText {
    presentationTitle: string;
    conceptTitle: string;
    mainConcepts: string[];
    viewpointDetails: { title: string; description: string; }[];
    conclusionTitle: string;
    conclusion: string;
}

export async function generatePresentationText(
    planImageSrc: string,
    scenes: GeneratedScene[],
    style: string,
    language: Language
): Promise<PresentationText> {
    const sceneImages = await Promise.all(scenes.filter(s => s.url).map(s => toDataUrl(s.url)));
    return post('presentation', {
        planImage: await toDataUrl(planImageSrc), sceneImages, style, language, brief: activeBrief,
    });
}
