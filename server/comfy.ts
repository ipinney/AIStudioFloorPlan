/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
// Image generation on the spark box's ComfyUI, using the same Qwen-Image models
// as the Plugged In pipeline (plugged-in/bin/qwen.py on spark):
//   - Qwen-Image-Edit 2511 for anything that starts from an image (plan render,
//     scene edits, adding a reference object). It follows instructions and keeps
//     the structure of the input.
//   - Qwen-Image 2512 for text-to-image (eye-level scenes from a viewpoint).
// Both run with the 8-step Lightning LoRAs. COMFY_URL must be reachable from
// wherever this server runs; on spark itself that is the default.

const COMFY_URL = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
const JOB_TIMEOUT_MS = Number(process.env.COMFY_TIMEOUT_MS || 15 * 60 * 1000);

const MODELS = {
    edit: 'qwen_image_edit_2511_fp8mixed.safetensors',
    editLora: 'Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors',
    t2i: 'qwen_image_2512_fp8_e4m3fn.safetensors',
    t2iLora: 'Qwen-Image-2512-Lightning-8steps-V1.0-bf16.safetensors',
    clip: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
    vae: 'qwen_image_vae.safetensors',
};

const NEGATIVE = 'blurry, lowres, deformed, distorted perspective, warped walls, cartoon, watermark, text, labels, people';

type Node = { class_type: string; inputs: Record<string, unknown> };
type Workflow = Record<string, Node>;

const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

function dataUrlToBlob(dataUrl: string): Blob {
    const match = dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.*)$/);
    if (!match) throw new Error('Expected an image data URL');
    return new Blob([Buffer.from(match[2], 'base64')], { type: match[1] });
}

async function uploadImage(dataUrl: string, name: string): Promise<string> {
    const form = new FormData();
    form.append('image', dataUrlToBlob(dataUrl), `${name}.png`);
    form.append('subfolder', 'floorplan');
    form.append('overwrite', 'true');
    const res = await fetch(`${COMFY_URL}/upload/image`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`ComfyUI upload failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as { name: string; subfolder: string };
    return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
}

async function runWorkflow(workflow: Workflow): Promise<string> {
    const res = await fetch(`${COMFY_URL}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow }),
    });
    if (!res.ok) throw new Error(`ComfyUI rejected the workflow: ${res.status} ${await res.text()}`);
    const { prompt_id: promptId } = await res.json() as { prompt_id: string };

    const deadline = Date.now() + JOB_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        const history = await (await fetch(`${COMFY_URL}/history/${promptId}`)).json() as Record<string, any>;
        const entry = history[promptId];
        if (!entry) continue;
        if (entry.status?.status_str === 'error') {
            const err = entry.status.messages?.find((m: any) => m[0] === 'execution_error')?.[1];
            throw new Error(`ComfyUI job failed: ${err?.exception_message || 'unknown error'}`);
        }
        for (const output of Object.values(entry.outputs || {}) as any[]) {
            const image = output.images?.[0];
            if (!image) continue;
            const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
            const img = await fetch(`${COMFY_URL}/view?${params}`);
            if (!img.ok) throw new Error(`Could not fetch ComfyUI output: ${img.status}`);
            return `data:image/png;base64,${Buffer.from(await img.arrayBuffer()).toString('base64')}`;
        }
        if (entry.status?.completed) throw new Error('ComfyUI job finished without an image');
    }
    throw new Error('ComfyUI job timed out');
}

function loaders(unet: string, lora: string): Workflow {
    return {
        unet: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
        clip: { class_type: 'CLIPLoader', inputs: { clip_name: MODELS.clip, type: 'qwen_image' } },
        vae: { class_type: 'VAELoader', inputs: { vae_name: MODELS.vae } },
        shift: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['unet', 0], shift: 3.1 } },
        lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['shift', 0], lora_name: lora, strength_model: 1.0 } },
    };
}

const sampler = (model: [string, number], latent: [string, number]): Node => ({
    class_type: 'KSampler',
    inputs: {
        model, positive: ['pos', 0], negative: ['neg', 0], latent_image: latent,
        seed: randomSeed(), steps: 8, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
    },
});

/** Text to image with Qwen-Image. Sizes are snapped to multiples of 16. */
export async function textToImage(prompt: string, width = 1344, height = 768): Promise<string> {
    const snap = (n: number) => Math.max(256, Math.round(n / 16) * 16);
    const wf: Workflow = {
        ...loaders(MODELS.t2i, MODELS.t2iLora),
        pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: prompt } },
        neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: NEGATIVE } },
        latent: { class_type: 'EmptySD3LatentImage', inputs: { width: snap(width), height: snap(height), batch_size: 1 } },
        sample: sampler(['lora', 0], ['latent', 0]),
        decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
        save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'floorplan/out' } },
    };
    return runWorkflow(wf);
}

/**
 * Instruction edit with Qwen-Image-Edit. `image` is edited; `reference` (e.g. a
 * piece of furniture to add) is passed as image 2. With a mask (white = change,
 * black = keep) only the painted region is regenerated and the rest is
 * composited back pixel for pixel.
 */
export async function editImage(opts: {
    image: string;
    instruction: string;
    mask?: string;
    reference?: string;
}): Promise<string> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const imageName = await uploadImage(opts.image, `in-${id}`);
    const wf: Workflow = {
        ...loaders(MODELS.edit, MODELS.editLora),
        norm: { class_type: 'CFGNorm', inputs: { model: ['lora', 0], strength: 1.0 } },
        load: { class_type: 'LoadImage', inputs: { image: imageName } },
        // ~1MP keeps the output aspect identical to the input and the runtime predictable;
        // sides snap to multiples of 16 as Qwen's latent patching expects.
        scaled: { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['load', 0], upscale_method: 'lanczos', megapixels: 1.0, resolution_steps: 16 } },
        encoded: { class_type: 'VAEEncode', inputs: { pixels: ['scaled', 0], vae: ['vae', 0] } },
        decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
    };
    const pos: Record<string, unknown> = { clip: ['clip', 0], prompt: opts.instruction, vae: ['vae', 0], image1: ['scaled', 0] };
    const neg: Record<string, unknown> = { clip: ['clip', 0], prompt: '', vae: ['vae', 0], image1: ['scaled', 0] };
    if (opts.reference) {
        wf.ref = { class_type: 'LoadImage', inputs: { image: await uploadImage(opts.reference, `ref-${id}`) } };
        pos.image2 = ['ref', 0];
        neg.image2 = ['ref', 0];
    }
    wf.pos = { class_type: 'TextEncodeQwenImageEditPlus', inputs: pos };
    wf.neg = { class_type: 'TextEncodeQwenImageEditPlus', inputs: neg };

    if (opts.mask) {
        const maskName = await uploadImage(opts.mask, `mask-${id}`);
        Object.assign(wf, {
            maskLoad: { class_type: 'LoadImageMask', inputs: { image: maskName, channel: 'red' } },
            maskImg: { class_type: 'MaskToImage', inputs: { mask: ['maskLoad', 0] } },
            scaledSize: { class_type: 'GetImageSize', inputs: { image: ['scaled', 0] } },
            maskScaled: { class_type: 'ImageScale', inputs: { image: ['maskImg', 0], upscale_method: 'nearest-exact', width: ['scaledSize', 0], height: ['scaledSize', 1], crop: 'disabled' } },
            mask: { class_type: 'ImageToMask', inputs: { image: ['maskScaled', 0], channel: 'red' } },
            masked: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['encoded', 0], mask: ['mask', 0] } },
            sample: sampler(['norm', 0], ['masked', 0]),
            composite: {
                class_type: 'ImageCompositeMasked',
                inputs: { destination: ['scaled', 0], source: ['decode', 0], x: 0, y: 0, resize_source: false, mask: ['mask', 0] },
            },
            save: { class_type: 'SaveImage', inputs: { images: ['composite', 0], filename_prefix: 'floorplan/out' } },
        });
    } else {
        Object.assign(wf, {
            sample: sampler(['norm', 0], ['encoded', 0]),
            save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'floorplan/out' } },
        });
    }
    return runWorkflow(wf);
}

export async function comfyHealth(): Promise<boolean> {
    try {
        const res = await fetch(`${COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    } catch {
        return false;
    }
}
