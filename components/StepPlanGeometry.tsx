/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useMemo, useRef, useState } from 'react';
import { Language, getTranslation } from '../lib/i18n';
import { extractPlanGeometry } from '../services/api';
import {
    centroid, dist, lerp, metersPerPixel, polygonArea, roomSchedule,
    type Opening, type PlanGeometry, type Pt, type Room,
} from '../shared/geometry';

interface Props {
    planImage: string;
    language: Language;
    geometry: PlanGeometry | null;
    onGeometryChange: (g: PlanGeometry | null) => void;
}

type Tool = 'select' | 'wall' | 'door' | 'window' | 'calibrate';
type Selection = { kind: 'wall' | 'opening' | 'room' | 'furniture'; id: string } | null;

const ROOM_TYPES: Room['type'][] = ['living', 'kitchen', 'dining', 'bedroom', 'bathroom', 'office', 'hall', 'closet', 'laundry', 'garage', 'outdoor', 'other'];
const OPENING_COLORS: Record<Opening['kind'], string> = { door: '#f97316', window: '#06b6d4', opening: '#22c55e' };

const StepPlanGeometry: React.FC<Props> = ({ planImage, language, geometry, onGeometryChange }) => {
    const t = (k: Parameters<typeof getTranslation>[0]) => getTranslation(k, language);
    const [isReading, setIsReading] = useState(false);
    const [error, setError] = useState('');
    const [tool, setTool] = useState<Tool>('select');
    const [selection, setSelection] = useState<Selection>(null);
    const [pending, setPending] = useState<Pt | null>(null);
    const [history, setHistory] = useState<PlanGeometry[]>([]);
    const svgRef = useRef<SVGSVGElement>(null);
    const dragging = useRef<{ from: Pt } | null>(null);

    const read = async () => {
        setIsReading(true);
        setError('');
        try {
            const g = await extractPlanGeometry(planImage);
            setHistory([]);
            onGeometryChange(g);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setIsReading(false);
        }
    };

    const commit = (next: PlanGeometry) => {
        if (geometry) setHistory(h => [...h.slice(-30), geometry]);
        onGeometryChange(next);
    };
    const undo = () => {
        const prev = history[history.length - 1];
        if (!prev) return;
        setHistory(h => h.slice(0, -1));
        onGeometryChange(prev);
    };

    const toPlan = (e: React.MouseEvent): Pt => {
        const svg = svgRef.current!;
        const pt = svg.createSVGPoint();
        pt.x = e.clientX; pt.y = e.clientY;
        const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
        return { x: p.x, y: p.y };
    };

    const size = geometry ? Math.max(geometry.image.width, geometry.image.height) : 1000;
    const handle = size * 0.008;
    const nextId = (prefix: string, items: { id: string }[]) => {
        let n = items.length + 1;
        while (items.some(i => i.id === `${prefix}${n}`)) n++;
        return `${prefix}${n}`;
    };

    /** Nearest wall to a point, with the position along it (0..1). */
    const nearestWall = (p: Pt) => {
        if (!geometry) return null;
        let best: { id: string; t: number; d: number } | null = null;
        for (const w of geometry.walls) {
            const l2 = (w.b.x - w.a.x) ** 2 + (w.b.y - w.a.y) ** 2;
            const tt = l2 ? Math.max(0, Math.min(1, ((p.x - w.a.x) * (w.b.x - w.a.x) + (p.y - w.a.y) * (w.b.y - w.a.y)) / l2)) : 0;
            const d = dist(p, lerp(w.a, w.b, tt));
            if (!best || d < best.d) best = { id: w.id, t: tt, d };
        }
        return best && best.d < size * 0.03 ? best : null;
    };

    const onCanvasClick = (e: React.MouseEvent) => {
        if (!geometry) return;
        const p = toPlan(e);
        if (tool === 'wall' || tool === 'calibrate') {
            if (!pending) { setPending(p); return; }
            if (tool === 'wall') {
                const thickness = geometry.walls[0]?.thickness ?? size * 0.01;
                commit({ ...geometry, walls: [...geometry.walls, { id: nextId('w', geometry.walls), a: pending, b: p, thickness, exterior: false }] });
            } else {
                const meters = Number(window.prompt(t('calibratePrompt'), '3.0'));
                if (meters > 0) commit({ ...geometry, scale: { metersPerPixel: meters / dist(pending, p), source: 'calibrated' } });
                setTool('select');
            }
            setPending(null);
            return;
        }
        if (tool === 'door' || tool === 'window') {
            const near = nearestWall(p);
            if (!near) return;
            const mpp = metersPerPixel(geometry);
            const width = (tool === 'door' ? 0.85 : 1.2) / mpp;
            commit({ ...geometry, openings: [...geometry.openings, { id: nextId('o', geometry.openings), wallId: near.id, kind: tool, t: near.t, width }] });
            return;
        }
        setSelection(null);
    };

    // Dragging a wall endpoint moves every endpoint at that junction.
    const startDrag = (e: React.MouseEvent, from: Pt) => {
        if (tool !== 'select') return;
        e.stopPropagation();
        dragging.current = { from };
        if (geometry) setHistory(h => [...h.slice(-30), geometry]);
    };
    const onMove = (e: React.MouseEvent) => {
        if (!dragging.current || !geometry) return;
        const p = toPlan(e);
        const from = dragging.current.from;
        const same = (q: Pt) => dist(q, from) < 0.5;
        onGeometryChange({
            ...geometry,
            walls: geometry.walls.map(w => ({ ...w, a: same(w.a) ? p : w.a, b: same(w.b) ? p : w.b })),
            rooms: geometry.rooms.map(r => ({ ...r, polygon: r.polygon.map(q => dist(q, from) < size * 0.012 ? p : q) })),
        });
        dragging.current = { from: p };
    };
    const endDrag = () => { dragging.current = null; };

    const deleteSelection = () => {
        if (!geometry || !selection) return;
        const { kind, id } = selection;
        commit({
            ...geometry,
            walls: kind === 'wall' ? geometry.walls.filter(w => w.id !== id) : geometry.walls,
            openings: geometry.openings.filter(o => !(kind === 'opening' && o.id === id) && !(kind === 'wall' && o.wallId === id)),
            rooms: kind === 'room' ? geometry.rooms.filter(r => r.id !== id) : geometry.rooms,
            furniture: kind === 'furniture' ? geometry.furniture.filter(f => f.id !== id) : geometry.furniture,
        });
        setSelection(null);
    };

    const updateRoom = (id: string, patch: Partial<Room>) => geometry && commit({ ...geometry, rooms: geometry.rooms.map(r => r.id === id ? { ...r, ...patch } : r) });
    const updateOpening = (id: string, patch: Partial<Opening>) => geometry && commit({ ...geometry, openings: geometry.openings.map(o => o.id === id ? { ...o, ...patch } : o) });

    const schedule = useMemo(() => geometry ? roomSchedule(geometry) : [], [geometry]);
    const junctions = useMemo(() => {
        if (!geometry) return [];
        const pts: Pt[] = [];
        for (const w of geometry.walls) for (const p of [w.a, w.b]) if (!pts.some(q => dist(q, p) < 0.5)) pts.push(p);
        return pts;
    }, [geometry]);

    const selectedRoom = selection?.kind === 'room' ? geometry?.rooms.find(r => r.id === selection.id) : undefined;
    const selectedOpening = selection?.kind === 'opening' ? geometry?.openings.find(o => o.id === selection.id) : undefined;

    const toolButton = (id: Tool, label: string) => (
        <button key={id} onClick={() => { setTool(id); setPending(null); }}
            className={`px-3 py-1.5 text-sm rounded-md border ${tool === id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}>
            {label}
        </button>
    );

    return (
        <div className="w-full max-w-6xl mx-auto">
            <h2 className="text-2xl font-bold mb-2 text-center text-slate-900">{t('geometryTitle')}</h2>
            <p className="text-center text-slate-500 mb-6 max-w-2xl mx-auto">{t('geometryDescription')}</p>

            {!geometry && (
                <div className="flex flex-col items-center gap-4">
                    <img src={planImage} alt="Floor plan" className="max-w-2xl w-full rounded-xl border border-slate-200" />
                    <button onClick={read} disabled={isReading}
                        className="px-6 py-3 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                        {isReading ? t('readingPlan') : t('readPlan')}
                    </button>
                    {error && <p className="text-sm text-red-600">{error}</p>}
                    <p className="text-sm text-slate-400">{t('geometryOptional')}</p>
                </div>
            )}

            {geometry && (
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                    <div className="lg:col-span-3">
                        <div className="flex flex-wrap gap-2 mb-3">
                            {toolButton('select', t('toolSelect'))}
                            {toolButton('wall', t('toolWall'))}
                            {toolButton('door', t('toolDoor'))}
                            {toolButton('window', t('toolWindow'))}
                            {toolButton('calibrate', t('toolCalibrate'))}
                            <button onClick={deleteSelection} disabled={!selection} className="px-3 py-1.5 text-sm rounded-md border border-red-300 text-red-700 disabled:opacity-40">{t('delete')}</button>
                            <button onClick={undo} disabled={!history.length} className="px-3 py-1.5 text-sm rounded-md border border-slate-300 text-slate-700 disabled:opacity-40">{t('undo')}</button>
                            <button onClick={read} disabled={isReading} className="ml-auto px-3 py-1.5 text-sm rounded-md border border-slate-300 text-slate-500 disabled:opacity-40">
                                {isReading ? t('readingPlan') : t('rereadPlan')}
                            </button>
                        </div>
                        <div className="relative border border-slate-200 rounded-xl overflow-hidden bg-white">
                            <img src={planImage} alt="Floor plan" className="w-full h-auto opacity-40 select-none" draggable={false} />
                            <svg ref={svgRef} viewBox={`0 0 ${geometry.image.width} ${geometry.image.height}`}
                                className={`absolute inset-0 w-full h-full ${tool === 'select' ? 'cursor-default' : 'cursor-crosshair'}`}
                                onClick={onCanvasClick} onMouseMove={onMove} onMouseUp={endDrag} onMouseLeave={endDrag}>
                                {geometry.rooms.map(r => (
                                    <polygon key={r.id} points={r.polygon.map(p => `${p.x},${p.y}`).join(' ')}
                                        fill={selection?.id === r.id ? 'rgba(99,102,241,0.25)' : 'rgba(99,102,241,0.08)'}
                                        stroke="rgba(99,102,241,0.4)" strokeWidth={handle * 0.3}
                                        onClick={e => { if (tool === 'select') { e.stopPropagation(); setSelection({ kind: 'room', id: r.id }); } }} />
                                ))}
                                {geometry.furniture.map(f => (
                                    <g key={f.id} transform={`translate(${f.x} ${f.y}) rotate(${f.rotation})`}
                                        onClick={e => { if (tool === 'select') { e.stopPropagation(); setSelection({ kind: 'furniture', id: f.id }); } }}>
                                        <rect x={-f.w / 2} y={-f.d / 2} width={f.w} height={f.d} fill="rgba(148,163,184,0.25)"
                                            stroke={selection?.id === f.id ? '#4f46e5' : '#94a3b8'} strokeWidth={handle * 0.3} />
                                    </g>
                                ))}
                                {geometry.walls.map(w => (
                                    <line key={w.id} x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y}
                                        stroke={selection?.id === w.id ? '#4f46e5' : w.exterior ? '#0f172a' : '#334155'}
                                        strokeWidth={Math.max(w.thickness, handle * 0.6)} strokeLinecap="square"
                                        onClick={e => { if (tool === 'select') { e.stopPropagation(); setSelection({ kind: 'wall', id: w.id }); } }} />
                                ))}
                                {geometry.openings.map(o => {
                                    const w = geometry.walls.find(x => x.id === o.wallId);
                                    if (!w) return null;
                                    const len = dist(w.a, w.b) || 1;
                                    const half = o.width / 2 / len;
                                    const a = lerp(w.a, w.b, Math.max(0, o.t - half)), b = lerp(w.a, w.b, Math.min(1, o.t + half));
                                    return (
                                        <line key={o.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={OPENING_COLORS[o.kind]}
                                            strokeWidth={Math.max(w.thickness, handle * 0.6) * (selection?.id === o.id ? 1.8 : 1.3)}
                                            onClick={e => { if (tool === 'select') { e.stopPropagation(); setSelection({ kind: 'opening', id: o.id }); } }} />
                                    );
                                })}
                                {tool === 'select' && junctions.map((p, i) => (
                                    <circle key={i} cx={p.x} cy={p.y} r={handle} fill="white" stroke="#4f46e5" strokeWidth={handle * 0.3}
                                        className="cursor-move" onMouseDown={e => startDrag(e, p)} />
                                ))}
                                {geometry.rooms.map(r => {
                                    const c = centroid(r.polygon);
                                    return (
                                        <text key={`l-${r.id}`} x={c.x} y={c.y} textAnchor="middle" fontSize={size * 0.018} fill="#312e81"
                                            className="select-none pointer-events-none font-semibold">{r.name}</text>
                                    );
                                })}
                                {pending && <circle cx={pending.x} cy={pending.y} r={handle * 1.2} fill="#ef4444" />}
                            </svg>
                        </div>
                        <p className="text-xs text-slate-400 mt-2">{t(`toolHint_${tool}` as `toolHint_${Tool}`)}</p>
                    </div>

                    <div className="space-y-4">
                        <div className="border border-slate-200 rounded-xl p-4 bg-white">
                            <h3 className="font-bold text-slate-900 mb-1">{t('scale')}</h3>
                            <p className="text-sm text-slate-600">
                                {geometry.scale.source === 'calibrated' ? t('scaleCalibrated') : geometry.scale.source === 'dimension-text' ? t('scaleFromDimensions') : t('scaleEstimated')}
                                {' '}({(1 / metersPerPixel(geometry)).toFixed(0)} px/m)
                            </p>
                            {geometry.scale.source !== 'calibrated' && (
                                <button onClick={() => { setTool('calibrate'); setPending(null); }} className="mt-2 text-sm text-indigo-700 underline">{t('toolCalibrate')}</button>
                            )}
                        </div>

                        {selectedRoom && (
                            <div className="border border-indigo-200 rounded-xl p-4 bg-indigo-50 space-y-2">
                                <input value={selectedRoom.name} onChange={e => updateRoom(selectedRoom.id, { name: e.target.value })}
                                    className="w-full px-2 py-1 border border-slate-300 rounded" />
                                <select value={selectedRoom.type} onChange={e => updateRoom(selectedRoom.id, { type: e.target.value as Room['type'] })}
                                    className="w-full px-2 py-1 border border-slate-300 rounded">
                                    {ROOM_TYPES.map(rt => <option key={rt} value={rt}>{rt}</option>)}
                                </select>
                                <p className="text-sm text-slate-600">{(polygonArea(selectedRoom.polygon) * metersPerPixel(geometry) ** 2).toFixed(1)} m²</p>
                            </div>
                        )}
                        {selectedOpening && (
                            <div className="border border-indigo-200 rounded-xl p-4 bg-indigo-50 space-y-2">
                                <select value={selectedOpening.kind} onChange={e => updateOpening(selectedOpening.id, { kind: e.target.value as Opening['kind'] })}
                                    className="w-full px-2 py-1 border border-slate-300 rounded">
                                    {(['door', 'window', 'opening'] as const).map(k => <option key={k} value={k}>{k}</option>)}
                                </select>
                                <label className="text-sm text-slate-600 flex items-center gap-2">
                                    {t('widthMeters')}
                                    <input type="number" step="0.05" min="0.3" className="w-20 px-2 py-1 border border-slate-300 rounded"
                                        value={(selectedOpening.width * metersPerPixel(geometry)).toFixed(2)}
                                        onChange={e => updateOpening(selectedOpening.id, { width: Number(e.target.value) / metersPerPixel(geometry) })} />
                                </label>
                            </div>
                        )}

                        <div className="border border-slate-200 rounded-xl p-4 bg-white">
                            <h3 className="font-bold text-slate-900 mb-2">{t('roomSchedule')}</h3>
                            <ul className="text-sm text-slate-600 space-y-1">
                                {schedule.map(line => <li key={line}>{line}</li>)}
                            </ul>
                        </div>

                        {geometry.notes.length > 0 && (
                            <div className="border border-amber-200 rounded-xl p-4 bg-amber-50">
                                <h3 className="font-bold text-amber-800 mb-2">{t('pleaseCheck')}</h3>
                                <ul className="text-sm text-amber-800 list-disc ml-5 space-y-1">
                                    {geometry.notes.map(n => <li key={n}>{n}</li>)}
                                </ul>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default StepPlanGeometry;
