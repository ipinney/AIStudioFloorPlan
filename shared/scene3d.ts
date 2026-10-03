/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
// Turns checked plan geometry into simple 3D primitives in meters. Both the
// browser walkthrough (three.js) and the Blender renderer on spark build from
// this one description, so every view agrees on where walls and openings are.
//
// Axes: x = plan x (right), z = plan y (down the plan), y = up. Origin is the
// plan image's top-left corner at floor level.
import { DEFAULTS, FURNITURE_HEIGHT, dist, metersPerPixel, type PlanGeometry, type Pt, type Room } from './geometry';

export type Vec3 = [number, number, number];

export interface Box {
    kind: 'wall' | 'glass' | 'furniture';
    center: Vec3;
    size: Vec3;
    /** Rotation about the vertical axis, radians (three.js convention). */
    rotationY: number;
    color: string;
    label?: string;
}

export interface Floor {
    roomId: string;
    name: string;
    type: Room['type'];
    /** Outline in meters, [x, z] pairs. */
    outline: [number, number][];
    color: string;
}

export interface Scene3D {
    boxes: Box[];
    floors: Floor[];
    ceilingHeight: number;
    bounds: { min: [number, number]; max: [number, number] };
    metersPerPixel: number;
}

export const FLOOR_COLORS: Record<Room['type'], string> = {
    living: '#c8a27a', dining: '#c8a27a', bedroom: '#d9c2a3', office: '#c8a27a', hall: '#c8a27a',
    kitchen: '#b9bcbf', bathroom: '#c9d3d6', laundry: '#c9d3d6', closet: '#d9c2a3',
    garage: '#9ea3a8', outdoor: '#8fa88a', other: '#c8a27a',
};

const FURNITURE_COLORS: Record<string, string> = {
    bed: '#e8e4dc', sofa: '#7d8a96', armchair: '#8f9aa5', table: '#9a7b5b', desk: '#9a7b5b', chair: '#6b5a48',
    wardrobe: '#d8d2c6', cabinet: '#d8d2c6', counter: '#f0efeb', island: '#f0efeb', fridge: '#dcdcdc', stove: '#3a3a3a',
    sink: '#e6e6e6', toilet: '#f7f7f7', tub: '#f7f7f7', shower: '#cfe3ea', vanity: '#e6e1d8', tv: '#222222',
    rug: '#b7a99a', plant: '#4f7a4a', other: '#a0a0a0',
};

export function buildScene(g: PlanGeometry): Scene3D {
    const mpp = metersPerPixel(g);
    const H = DEFAULTS.ceilingHeight;
    const m = (p: Pt): [number, number] => [p.x * mpp, p.y * mpp];
    const boxes: Box[] = [];

    for (const w of g.walls) {
        const [ax, az] = m(w.a), [bx, bz] = m(w.b);
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.05) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        const thick = Math.max(0.08, w.thickness * mpp);
        const rotationY = -Math.atan2(uz, ux);
        // Extend each end by half the thickness so corners close.
        const start = -thick / 2, end = len + thick / 2;

        const openings = g.openings
            .filter(o => o.wallId === w.id)
            .map(o => {
                const c = o.t * dist(w.a, w.b) * mpp, half = (o.width * mpp) / 2;
                return { kind: o.kind, s: Math.max(0, c - half), e: Math.min(len, c + half) };
            })
            .sort((a, b) => a.s - b.s);

        const piece = (s: number, e: number, y0: number, y1: number, kind: Box['kind'] = 'wall') => {
            if (e - s < 0.01 || y1 - y0 < 0.01) return;
            const mid = (s + e) / 2;
            boxes.push({
                kind,
                center: [ax + ux * mid, (y0 + y1) / 2, az + uz * mid],
                size: [e - s, y1 - y0, kind === 'glass' ? 0.02 : thick],
                rotationY,
                color: kind === 'glass' ? '#a9c9d8' : w.exterior ? '#f2f0ec' : '#f7f6f3',
            });
        };

        let cursor = start;
        for (const o of openings) {
            piece(cursor, o.s, 0, H);
            if (o.kind === 'window') {
                piece(o.s, o.e, 0, DEFAULTS.windowSill);
                piece(o.s, o.e, DEFAULTS.windowSill, DEFAULTS.windowHead, 'glass');
                piece(o.s, o.e, DEFAULTS.windowHead, H);
            } else {
                piece(o.s, o.e, DEFAULTS.doorHeight, H);
            }
            cursor = Math.max(cursor, o.e);
        }
        piece(cursor, end, 0, H);
    }

    for (const f of g.furniture) {
        const h = FURNITURE_HEIGHT[f.kind] ?? 0.8;
        const [x, z] = m(f);
        boxes.push({
            kind: 'furniture',
            center: [x, h / 2, z],
            size: [Math.max(0.1, f.w * mpp), h, Math.max(0.1, f.d * mpp)],
            rotationY: (-f.rotation * Math.PI) / 180,
            color: FURNITURE_COLORS[f.kind] ?? '#a0a0a0',
            label: f.kind,
        });
    }

    const floors: Floor[] = g.rooms.map(r => ({
        roomId: r.id, name: r.name, type: r.type, outline: r.polygon.map(m), color: FLOOR_COLORS[r.type],
    }));

    const xs = g.walls.flatMap(w => [w.a.x, w.b.x]).map(v => v * mpp);
    const zs = g.walls.flatMap(w => [w.a.y, w.b.y]).map(v => v * mpp);
    const bounds = xs.length
        ? { min: [Math.min(...xs), Math.min(...zs)] as [number, number], max: [Math.max(...xs), Math.max(...zs)] as [number, number] }
        : { min: [0, 0] as [number, number], max: [g.image.width * mpp, g.image.height * mpp] as [number, number] };

    return { boxes, floors, ceilingHeight: H, bounds, metersPerPixel: mpp };
}

/** A viewpoint (normalized plan coords + heading) as a camera in scene meters. */
export interface Camera3D {
    position: Vec3;
    /** Point the camera looks at. */
    target: Vec3;
    /** Horizontal field of view, degrees. */
    fov: number;
}

export const EYE_HEIGHT = 1.6;

export function headingToward(from: Pt, to: Pt): number {
    return (Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI;
}

/** Heading in plan degrees (0 = up the plan, clockwise) → unit vector in scene x/z. */
export function headingVector(headingDeg: number): [number, number] {
    const r = (headingDeg * Math.PI) / 180;
    return [Math.sin(r), -Math.cos(r)];
}

export function cameraFor(g: PlanGeometry, view: { u: number; v: number; heading: number }, fov = 75, tiltDeg = 0): Camera3D {
    const mpp = metersPerPixel(g);
    const x = view.u * g.image.width * mpp, z = view.v * g.image.height * mpp;
    const [dx, dz] = headingVector(view.heading);
    const tilt = Math.tan((tiltDeg * Math.PI) / 180);
    return { position: [x, EYE_HEIGHT, z], target: [x + dx, EYE_HEIGHT + tilt, z + dz], fov };
}

/**
 * Default aim when the homeowner placed a viewpoint without dragging: face the
 * far side of the room, which shows the most of it.
 */
export function defaultHeading(g: PlanGeometry, p: Pt, room?: Room): number {
    if (!room) return 0;
    let far = room.polygon[0];
    for (const q of room.polygon) if (dist(p, q) > dist(p, far)) far = q;
    const c = room.polygon.reduce((s, q) => ({ x: s.x + q.x / room.polygon.length, y: s.y + q.y / room.polygon.length }), { x: 0, y: 0 });
    // Halfway between the farthest corner and the room center keeps walls framed.
    return headingToward(p, { x: (far.x + c.x) / 2, y: (far.y + c.y) / 2 });
}
