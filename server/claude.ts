/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
// Everything that needs judgment (the interview, reading the plan, writing
// image prompts, presentation copy) goes through Claude. Images are made on spark.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import {
    InterviewTurnSchema, briefToText,
    type DesignBrief, type InterviewMessage, type InterviewTurn,
} from '../shared/brief';
import { PlanGeometrySchema, tidyGeometry, type PlanGeometry } from '../shared/geometry';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

const client = new Anthropic();

type Lang = 'en' | 'zh';
const languageName = (lang: Lang) => lang === 'zh' ? 'Traditional Chinese (Taiwan)' : 'English';

function imageBlock(dataUrl: string): Anthropic.Beta.BetaImageBlockParam {
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/);
    if (!match) throw new Error('Expected a PNG, JPEG, GIF or WebP data URL');
    return {
        type: 'image',
        source: { type: 'base64', media_type: match[1] as 'image/png', data: match[2] },
    };
}

/** Structured call with a refusal check; returns the parsed object. */
async function structured<T extends z.ZodType>(opts: {
    schema: T;
    system: string;
    messages: Anthropic.Beta.BetaMessageParam[];
    effort?: 'low' | 'medium' | 'high';
    maxTokens?: number;
}): Promise<z.infer<T>> {
    const response = await client.beta.messages.parse({
        model: MODEL,
        max_tokens: opts.maxTokens ?? 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        cache_control: { type: 'ephemeral' },
        output_config: { effort: opts.effort ?? 'medium', format: betaZodOutputFormat(opts.schema) },
        system: opts.system,
        messages: opts.messages,
    });
    if (response.stop_reason === 'refusal') {
        throw new Error(`Claude declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}`);
    }
    if (!response.parsed_output) throw new Error(`Claude returned no structured output (stop: ${response.stop_reason})`);
    return response.parsed_output as z.infer<T>;
}

// --- The architect interview -------------------------------------------------

const INTERVIEW_SYSTEM = `You are a residential architect running the first programming meeting with a homeowner. They uploaded the floor plan attached to the first message. Your job is to learn how they actually live so the design fits them, then hand a Design Brief to the visualization team.

How a good architect runs this meeting:
- Start from the plan: say what you notice (room count, light, flow, pinch points) in a sentence, then ask about the people before the finishes.
- Ask one question at a time, two at most when they are tightly linked. Keep each turn short: a sentence reacting to what they said, then the question.
- Prefer concrete, behavioral questions over abstract ones. "Walk me through a weekday morning: who's up first, where do bags and shoes land?" beats "What is your lifestyle?" "Show me a room you've loved and tell me why" beats "What style do you like?"
- Cover, roughly in this order, skipping what you already know: household (who, ages, pets, accessibility, aging in place) → daily life (work from home, cooking, entertaining, routines, storage pain) → site (new build or remodel, orientation and light, climate, views, noise, what can't move) → budget and timeline (range, where to splurge vs save) → look and feel (style, materials, palette, loves, dislikes) → room-by-room needs.
- Push back like a professional when the plan and their life conflict: a bedroom sharing a wall with the TV room for a light sleeper, a home office with no door, a kitchen too small for the cook they described. Record these in concerns and raise them kindly.
- Offer 2 to 5 quickReplies when the question has natural short answers; leave it empty for open questions.
- Never invent facts. Fields you have not learned stay null or empty. Always return the full brief with everything learned so far.
- After roughly 8 to 14 exchanges, or sooner if the homeowner wants to move on, read back a short summary (topic "review") and ask them to confirm or correct it. Set complete to true only after they confirm.
- aesthetic.style must be a short phrase an image model can use, e.g. "warm Japandi with white oak and linen".`;

export async function interviewTurn(opts: {
    planImage: string;
    history: InterviewMessage[];
    brief: DesignBrief | null;
    language: Lang;
}): Promise<InterviewTurn> {
    const opening: Anthropic.Beta.BetaContentBlockParam[] = [
        imageBlock(opts.planImage),
        { type: 'text', text: `Here is my floor plan. Please conduct the interview in ${languageName(opts.language)}.` },
    ];
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: opening }];
    for (const turn of opts.history) {
        const last = messages[messages.length - 1];
        if (last.role === turn.role) {
            // Keep the alternation the API expects if the client sent two in a row.
            messages.push({ role: turn.role === 'user' ? 'assistant' : 'user', content: '(continue)' });
        }
        messages.push({ role: turn.role, content: turn.content });
    }
    if (messages[messages.length - 1].role === 'assistant') {
        messages.push({ role: 'user', content: '(continue)' });
    }
    return structured({ schema: InterviewTurnSchema, system: INTERVIEW_SYSTEM, messages, effort: 'medium' });
}

// --- Prompt writing for spark's Qwen-Image models ---------------------------

const ImagePromptSchema = z.object({
    prompt: z.string().describe('The prompt, 60 to 180 words'),
});

const SCENE_WRITER_SYSTEM = `You write prompts for Qwen-Image, a text-to-image model. Write a dense, concrete photographic description: camera and lens, light, the room's layout as seen from the camera, materials, furniture, decor. Describe only what is visible. Always end with: "The room is unoccupied, no people." Never ask for text, labels or watermarks.`;

const EDIT_WRITER_SYSTEM = `You write instructions for Qwen-Image-Edit, an instruction-following image editor that receives the image(s) and your text. Write imperative edit instructions ("Convert…", "Replace…", "Add…"), say explicitly what must stay unchanged (camera angle, walls, windows, doors, layout), and be concrete about materials, colors and furniture. Refer to input images as "image 1" and "image 2". Never ask for text, labels or watermarks.`;

export async function planRenderingPrompt(planImage: string, brief: DesignBrief | null, instruction?: string, layout?: string): Promise<string> {
    const result = await structured({
        schema: ImagePromptSchema,
        system: EDIT_WRITER_SYSTEM,
        effort: 'low',
        messages: [{
            role: 'user',
            content: [
                imageBlock(planImage),
                {
                    type: 'text', text: instruction
                        ? `This image (image 1) is a floor plan rendering. Write an edit instruction that applies this requested change while keeping every other wall, opening and room exactly where it is: ${instruction}
${brief ? `Design brief:\n${briefToText(brief)}` : ''}`
                        : `Write an edit instruction that converts this floor plan (image 1) into a clean top-down 3D architectural visualization: orthographic bird's-eye view, roof removed, matte white walls with visible thickness, soft ambient occlusion, realistic flooring per room, furniture seen from above. All text, dimensions, labels and annotations removed. Every wall, door swing, window and room boundary stays exactly where it is. Name the rooms you can identify and say how to furnish each one for this household.
${layout ? `Measured room layout (checked by the homeowner; keep each room where it is):\n${layout}\n` : ''}${brief ? `Design brief:\n${briefToText(brief)}` : ''}`,
                },
            ],
        }],
    });
    return result.prompt;
}

export async function scenePrompt(opts: {
    markedPlan: string;
    viewIndex: number;
    brief: DesignBrief | null;
    style: string;
    camera: { rotation: number; tilt: number; zoom: number };
    mode: 'day' | 'night';
    temperature: number;
    viewFacts?: string;
}): Promise<string> {
    const { camera } = opts;
    const result = await structured({
        schema: ImagePromptSchema,
        system: SCENE_WRITER_SYSTEM,
        effort: 'medium',
        messages: [{
            role: 'user',
            content: [
                imageBlock(opts.markedPlan),
                {
                    type: 'text', text: `A person stands at the red marker numbered ${opts.viewIndex} on this floor plan, eye level (1.6 m), looking toward the most interesting part of the room${camera.rotation ? `, then turned ${Math.abs(camera.rotation)}° to the ${camera.rotation > 0 ? 'right' : 'left'}` : ''}${camera.tilt ? `, camera tilted ${Math.abs(camera.tilt)}° ${camera.tilt > 0 ? 'up' : 'down'}` : ''}${camera.zoom > 1 ? ', tighter framing' : camera.zoom < 1 ? ', wide-angle framing' : ''}.
${opts.viewFacts ? `Measured from the checked plan geometry (trust this over your reading of the image; directions are relative to where the camera faces): ${opts.viewFacts}\n` : ''}First work out which room they are in, which walls, windows and doors are in front of them and roughly how far away, then write a prompt for a photorealistic interior photograph of exactly that view.
Style: ${opts.style || opts.brief?.aesthetic.style || 'warm contemporary'}.
Lighting: ${opts.mode === 'day' ? `daylight through the windows, about ${opts.temperature}K` : `night, windows dark, warm lamps and recessed lights about ${opts.temperature}K, high contrast`}.
${opts.brief ? `Design brief:\n${briefToText(opts.brief)}` : ''}`,
                },
            ],
        }],
    });
    return result.prompt;
}

export async function editPrompt(opts: {
    scene: string;
    instruction: string;
    mode: 'day' | 'night';
    temperature: number;
    objectImage?: string;
    masked: boolean;
}): Promise<string> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [imageBlock(opts.scene)];
    if (opts.objectImage) content.push(imageBlock(opts.objectImage));
    content.push({
        type: 'text', text: `Image 1 is an interior photograph the homeowner wants edited${opts.masked ? ' (only a painted region will change, so describe the change for that region)' : ''}.${opts.objectImage ? ' Image 2 is an object they want placed in the room; tell the editor to add the object from image 2, matched to the room\'s perspective, scale and light.' : ''}
Requested change: ${opts.instruction || 'none, lighting only'}.
Lighting: ${opts.mode === 'day' ? `daylight through the windows, about ${opts.temperature}K` : `night, windows dark, warm lamps and recessed lights about ${opts.temperature}K`}.
Write one edit instruction. Keep the camera angle, room architecture and everything not mentioned unchanged.`,
    });
    const result = await structured({ schema: ImagePromptSchema, system: EDIT_WRITER_SYSTEM, effort: 'low', messages: [{ role: 'user', content }] });
    return result.prompt;
}

// --- Reading the plan into geometry -------------------------------------------

const GEOMETRY_SYSTEM = `You are an architectural drafter digitizing a residential floor plan into vector geometry. The image has a labelled pixel grid drawn over it; use the grid labels to read coordinates precisely. Coordinates are pixels in the original image, origin top-left, y pointing down.

Rules:
- Walls are straight segments along wall centerlines. Split a wall wherever another wall meets it, so endpoints coincide at junctions and corners. Mark exterior walls.
- Openings sit on a wall: give the wallId, t (0 at wall.a to 1 at wall.b, the opening's center), and width in pixels. A door gap with a swing arc is a door; a thin double/triple line in a wall is a window; a gap with no swing is an opening.
- Rooms are closed polygons along the wall centerlines. Name them as a homeowner would. Use printed labels when present; otherwise infer from fixtures (toilet → bathroom, bed → bedroom).
- Furniture: read drawn symbols (beds, sofas, tables, kitchen counters, toilets, tubs, wardrobes). Give center, size and rotation. Do not invent furniture that is not drawn.
- Scale: if dimensions are printed (e.g. "4.2m", "12'-6\""), compute metersPerPixel and set source "dimension-text". Otherwise null with source "estimated".
- Ids: w1, w2… for walls, o1… openings, r1… rooms, f1… furniture.
- Put anything you are unsure about in notes, in plain language for a homeowner.`;

export async function extractGeometry(gridImage: string, width: number, height: number): Promise<PlanGeometry> {
    const raw = await structured({
        schema: PlanGeometrySchema,
        system: GEOMETRY_SYSTEM,
        effort: 'high',
        maxTokens: 32000,
        messages: [{
            role: 'user',
            content: [
                imageBlock(gridImage),
                { type: 'text', text: `The plan image is ${width} × ${height} pixels. Digitize it. Set image to {"width": ${width}, "height": ${height}}.` },
            ],
        }],
    });
    return tidyGeometry({ ...raw, image: { width, height } });
}

// --- Short text helpers ------------------------------------------------------

export async function suggestStyle(planImage: string, brief: DesignBrief | null): Promise<string> {
    const result = await structured({
        schema: z.object({ style: z.string() }),
        system: 'You are a residential interior architect.',
        effort: 'low',
        messages: [{
            role: 'user',
            content: [imageBlock(planImage), { type: 'text', text: `Suggest one short interior style phrase (under 8 words) that fits this plan${brief ? ' and this household' : ''}.${brief ? `\n${briefToText(brief)}` : ''}` }],
        }],
    });
    return result.style;
}

export async function suggestStyleIdeas(brief: DesignBrief | null): Promise<string[]> {
    const result = await structured({
        schema: z.object({ styles: z.array(z.string()) }),
        system: 'You are a residential interior architect.',
        effort: 'low',
        messages: [{ role: 'user', content: `Give 6 distinct interior style names (2 to 4 words each)${brief ? ' that would suit this household' : ''}.${brief ? `\n${briefToText(brief)}` : ''}` }],
    });
    return result.styles.slice(0, 6);
}

export async function suggestPlanImprovement(planImage: string, brief: DesignBrief | null): Promise<string> {
    const result = await structured({
        schema: z.object({ suggestion: z.string() }),
        system: 'You are a residential architect reviewing a plan for a client.',
        effort: 'medium',
        messages: [{
            role: 'user',
            content: [imageBlock(planImage), { type: 'text', text: `Give one concrete, single-sentence layout or furniture change that would most improve this plan${brief ? ' for this household' : ''}. It will be passed to an image editor, so phrase it as an instruction.${brief ? `\n${briefToText(brief)}` : ''}` }],
        }],
    });
    return result.suggestion;
}

const PresentationSchema = z.object({
    presentationTitle: z.string(),
    conceptTitle: z.string(),
    mainConcepts: z.array(z.string()),
    viewpointDetails: z.array(z.object({ title: z.string(), description: z.string() })),
    conclusionTitle: z.string(),
    conclusion: z.string(),
});
export type PresentationText = z.infer<typeof PresentationSchema>;

export async function presentationText(opts: {
    planImage: string;
    sceneImages: string[];
    style: string;
    brief: DesignBrief | null;
    language: Lang;
}): Promise<PresentationText> {
    const lang = languageName(opts.language);
    return structured({
        schema: PresentationSchema,
        system: 'You are an architect writing a short client presentation.',
        effort: 'medium',
        messages: [{
            role: 'user',
            content: [
                imageBlock(opts.planImage),
                ...opts.sceneImages.map(imageBlock),
                {
                    type: 'text', text: `Write the presentation copy in ${lang} only (translate the style name if needed). The first image is the plan; the next ${opts.sceneImages.length} are the viewpoints in order.
Tie each point back to how this household lives, not generic design talk.
Limits: presentationTitle ≤10 words; conceptTitle ≤7; mainConcepts exactly 4, each "Title: explanation" ≤15 words; viewpointDetails one per viewpoint, title ≤7 words, description ≤30; conclusionTitle ≤7; conclusion ≤40.
Style: ${opts.style}
${opts.brief ? `Design brief:\n${briefToText(opts.brief)}` : ''}`,
                },
            ],
        }],
    });
}
