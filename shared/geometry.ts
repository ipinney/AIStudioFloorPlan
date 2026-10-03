/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import * as z from 'zod/v4';

/**
 * Plan geometry: the single source of truth for the layout once the
 * homeowner has checked it. Coordinates are pixels in the uploaded plan image
 * (origin top-left, y down). `scale.metersPerPixel` converts to real units.
 */

const Point = z.object({ x: z.number(), y: z.number() });

export const WallSchema = z.object({
    id: z.string(),
    a: Point,
    b: Point,
    thickness: z.number().describe('Wall thickness in pixels'),
    exterior: z.boolean(),
});

export const OpeningSchema = z.object({
    id: z.string(),
    wallId: z.string(),
    kind: z.enum(['door', 'window', 'opening']).describe('opening = doorless passage'),
    t: z.number().describe('Center of the opening along the wall, 0 at wall.a, 1 at wall.b'),
    width: z.number().describe('Opening width in pixels'),
});

export const RoomSchema = z.object({
    id: z.string(),
    name: z.string().describe('As the homeowner would say it, e.g. "Primary bedroom"'),
    type: z.enum(['living', 'kitchen', 'dining', 'bedroom', 'bathroom', 'office', 'hall', 'closet', 'laundry', 'garage', 'outdoor', 'other']),
    polygon: z.array(Point).describe('Room outline, clockwise, following wall centerlines'),
});

export const FurnitureSchema = z.object({
    id: z.string(),
    roomId: z.string(),
    kind: z.enum(['bed', 'sofa', 'armchair', 'table', 'desk', 'chair', 'wardrobe', 'cabinet', 'counter', 'island', 'fridge', 'stove', 'sink', 'toilet', 'tub', 'shower', 'vanity', 'tv', 'rug', 'plant', 'other']),
    x: z.number().describe('Center x in pixels'),
    y: z.number().describe('Center y in pixels'),
    w: z.number().describe('Width in pixels (along its own x axis before rotation)'),
    d: z.number().describe('Depth in pixels'),
    rotation: z.number().describe('Degrees clockwise; 0 means the front faces down the image (+y)'),
});

export const PlanGeometrySchema = z.object({
    image: z.object({ width: z.number(), height: z.number() }),
    scale: z.object({
        metersPerPixel: z.number().nullable().describe('Null until known; estimate from printed dimensions if any'),
        source: z.enum(['estimated', 'dimension-text', 'calibrated']),
    }),
    walls: z.array(WallSchema),
    openings: z.array(OpeningSchema),
    rooms: z.array(RoomSchema),
    furniture: z.array(FurnitureSchema),
    notes: z.array(z.string()).describe('Anything uncertain the homeowner should check'),
});

export type Pt = z.infer<typeof Point>;
export type Wall = z.infer<typeof WallSchema>;
export type Opening = z.infer<typeof OpeningSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type Furniture = z.infer<typeof FurnitureSchema>;
export type PlanGeometry = z.infer<typeof PlanGeometrySchema>;

// Typical residential dimensions, used when the plan gives no scale and for 3D.
export const DEFAULTS = {
    ceilingHeight: 2.7,
    doorHeight: 2.1,
    windowSill: 0.9,
    windowHead: 2.2,
    // A typical interior door is ~0.85 m; used to estimate scale from door widths.
    doorWidth: 0.85,
};

export const FURNITURE_HEIGHT: Record<Furniture['kind'], number> = {
    bed: 0.55, sofa: 0.8, armchair: 0.8, table: 0.75, desk: 0.75, chair: 0.9, wardrobe: 2.1, cabinet: 0.9,
    counter: 0.9, island: 0.9, fridge: 1.8, stove: 0.9, sink: 0.9, toilet: 0.75, tub: 0.55, shower: 2.0,
    vanity: 0.85, tv: 1.2, rug: 0.01, plant: 1.2, other: 0.8,
};

// --- Geometry helpers ---------------------------------------------------------

export const dist = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);
export const lerp = (p: Pt, q: Pt, t: number): Pt => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });

/** Effective scale: calibrated/estimated value, else inferred from door widths, else a 10m-wide-plan guess. */
export function metersPerPixel(g: PlanGeometry): number {
    if (g.scale.metersPerPixel && g.scale.metersPerPixel > 0) return g.scale.metersPerPixel;
    const doors = g.openings.filter(o => o.kind === 'door').map(o => o.width).sort((a, b) => a - b);
    if (doors.length) return DEFAULTS.doorWidth / doors[Math.floor(doors.length / 2)];
    return 10 / g.image.width;
}

export function polygonArea(poly: Pt[]): number {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

export function centroid(poly: Pt[]): Pt {
    const n = poly.length || 1;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
}

/**
 * Cleans model output: snaps nearly-axis-aligned walls to the axis, merges wall
 * endpoints that nearly touch, clamps opening positions, and drops degenerate
 * items. Tolerances scale with the image size.
 */
export function tidyGeometry(g: PlanGeometry): PlanGeometry {
    const size = Math.max(g.image.width, g.image.height);
    const snapTol = size * 0.012;
    const walls = g.walls
        .map(w => ({ ...w, a: { ...w.a }, b: { ...w.b } }))
        .filter(w => dist(w.a, w.b) > snapTol);

    // Axis snap (within ~3 degrees of horizontal/vertical), then merge endpoints
    // that nearly touch. Merging can nudge a wall off-axis, so do it twice.
    for (let pass = 0; pass < 2; pass++) {
        for (const w of walls) {
            const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y;
            if (Math.abs(dy) < Math.abs(dx) * 0.05) { const y = (w.a.y + w.b.y) / 2; w.a.y = y; w.b.y = y; }
            else if (Math.abs(dx) < Math.abs(dy) * 0.05) { const x = (w.a.x + w.b.x) / 2; w.a.x = x; w.b.x = x; }
        }
        const ends: Pt[] = walls.flatMap(w => [w.a, w.b]);
        const visited = new Set<Pt>();
        for (const p of ends) {
            if (visited.has(p)) continue;
            const cluster = ends.filter(q => !visited.has(q) && dist(p, q) < snapTol);
            const mx = cluster.reduce((s, q) => s + q.x, 0) / cluster.length;
            const my = cluster.reduce((s, q) => s + q.y, 0) / cluster.length;
            for (const q of cluster) { q.x = mx; q.y = my; visited.add(q); }
        }
    }

    const wallIds = new Set(walls.map(w => w.id));
    const openings = g.openings
        .filter(o => wallIds.has(o.wallId) && o.width > 0)
        .map(o => ({ ...o, t: Math.min(0.98, Math.max(0.02, o.t)) }));
    const rooms = g.rooms.filter(r => r.polygon.length >= 3);
    const roomIds = new Set(rooms.map(r => r.id));
    const furniture = g.furniture.filter(f => f.w > 0 && f.d > 0).map(f => roomIds.has(f.roomId) ? f : { ...f, roomId: roomAt(rooms, f)?.id ?? f.roomId });
    return { ...g, walls, openings, rooms, furniture };
}

export function roomAt(rooms: Room[], p: Pt): Room | undefined {
    return rooms.find(r => pointInPolygon(p, r.polygon));
}

/** Room schedule lines like "Living room: 4.2 × 6.1 m (25.6 m²)". */
export function roomSchedule(g: PlanGeometry): string[] {
    const mpp = metersPerPixel(g);
    return g.rooms.map(r => {
        const xs = r.polygon.map(p => p.x), ys = r.polygon.map(p => p.y);
        const w = (Math.max(...xs) - Math.min(...xs)) * mpp, h = (Math.max(...ys) - Math.min(...ys)) * mpp;
        const area = polygonArea(r.polygon) * mpp * mpp;
        return `${r.name}: ${w.toFixed(1)} × ${h.toFixed(1)} m (${area.toFixed(1)} m²)`;
    });
}

const COMPASS = ['ahead', 'ahead-right', 'right', 'behind-right', 'behind', 'behind-left', 'left', 'ahead-left'];

/**
 * Plain-language description of what a camera at `p`, facing `headingDeg`
 * (0 = up the image, clockwise), can see: the room it is in, the room size, and
 * where windows and doors sit relative to the view. Grounds the scene prompt
 * in the real layout instead of the model's guess.
 */
export function describeView(g: PlanGeometry, p: Pt, headingDeg: number): string {
    const mpp = metersPerPixel(g);
    const room = roomAt(g.rooms, p);
    const lines: string[] = [];
    if (room) {
        const xs = room.polygon.map(q => q.x), ys = room.polygon.map(q => q.y);
        lines.push(`Camera is in the ${room.name} (${room.type}), about ${((Math.max(...xs) - Math.min(...xs)) * mpp).toFixed(1)} × ${((Math.max(...ys) - Math.min(...ys)) * mpp).toFixed(1)} m.`);
    }
    const relative = (q: Pt) => {
        const bearing = (Math.atan2(q.x - p.x, -(q.y - p.y)) * 180) / Math.PI;
        const rel = ((bearing - headingDeg) % 360 + 360) % 360;
        return { dir: COMPASS[Math.round(rel / 45) % 8], meters: dist(p, q) * mpp };
    };
    const wallsById = new Map(g.walls.map(w => [w.id, w]));
    const seen: string[] = [];
    for (const o of g.openings) {
        const w = wallsById.get(o.wallId);
        if (!w) continue;
        const c = lerp(w.a, w.b, o.t);
        const r = relative(c);
        if (r.meters > 8) continue;
        // Only openings that belong to this room (or the room is unknown).
        if (room && !room.polygon.some((_, i) => segmentNear(room.polygon[i], room.polygon[(i + 1) % room.polygon.length], c, w.thickness * 2))) continue;
        seen.push(`a ${o.kind === 'opening' ? 'wide opening' : o.kind} ${(o.width * mpp).toFixed(1)} m wide, ${r.dir}, ${r.meters.toFixed(1)} m away`);
    }
    if (seen.length) lines.push(`Openings: ${seen.join('; ')}.`);
    const furn = g.furniture.filter(f => !room || f.roomId === room.id).map(f => {
        const r = relative(f);
        return r.dir.startsWith('behind') ? null : `${f.kind} ${r.dir} ${r.meters.toFixed(1)} m`;
    }).filter(Boolean);
    if (furn.length) lines.push(`Furniture in view: ${furn.join('; ')}.`);
    lines.push(`Ceiling height about ${DEFAULTS.ceilingHeight} m.`);
    return lines.join(' ');
}

function segmentNear(a: Pt, b: Pt, p: Pt, tol: number): boolean {
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0;
    return dist(p, lerp(a, b, t)) <= tol;
}

/** Compact text form of the layout for prompts (room list with positions). */
export function layoutToText(g: PlanGeometry): string {
    const W = g.image.width, H = g.image.height;
    const where = (p: Pt) => `${p.y < H / 3 ? 'top' : p.y > (2 * H) / 3 ? 'bottom' : 'middle'}-${p.x < W / 3 ? 'left' : p.x > (2 * W) / 3 ? 'right' : 'center'}`;
    const schedule = roomSchedule(g);
    return g.rooms.map((r, i) => `${schedule[i]}, ${where(centroid(r.polygon))} of the plan`).join('\n');
}
