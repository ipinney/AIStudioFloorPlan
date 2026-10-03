/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
// Walk-through of the checked plan, built from shared/scene3d.ts (the same
// description the Blender renderer uses). Orbit to see the whole home, or walk
// at eye level and drop viewpoints that become the cameras for scene renders.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PointerLockControls } from '@react-three/drei';
import * as THREE from 'three';
import { Language, getTranslation } from '../lib/i18n';
import { centroid, polygonArea, type PlanGeometry } from '../shared/geometry';
import { buildScene, defaultHeading, EYE_HEIGHT, headingVector, type Scene3D } from '../shared/scene3d';
import type { ScenePoint } from './Step3SceneGeneration';

interface Props {
    geometry: PlanGeometry;
    scenePoints: ScenePoint[];
    onAddViewpoint: (p: ScenePoint) => void;
    language: Language;
}

type Mode = 'orbit' | 'walk';

const Walkthrough3D: React.FC<Props> = ({ geometry, scenePoints, onAddViewpoint, language }) => {
    const t = (k: Parameters<typeof getTranslation>[0]) => getTranslation(k, language);
    const scene = useMemo(() => buildScene(geometry), [geometry]);
    const [mode, setMode] = useState<Mode>('orbit');
    const [locked, setLocked] = useState(false);
    const dropRef = useRef<() => void>(() => {});

    const center: [number, number, number] = [
        (scene.bounds.min[0] + scene.bounds.max[0]) / 2, 0, (scene.bounds.min[1] + scene.bounds.max[1]) / 2,
    ];
    const span = Math.max(scene.bounds.max[0] - scene.bounds.min[0], scene.bounds.max[1] - scene.bounds.min[1]);

    // Walk mode starts in the middle of the largest room, facing its far side.
    const start = useMemo(() => {
        const mpp = scene.metersPerPixel;
        const big = [...geometry.rooms].sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))[0];
        const c = big ? centroid(big.polygon) : { x: geometry.image.width / 2, y: geometry.image.height / 2 };
        return { position: [c.x * mpp, EYE_HEIGHT, c.y * mpp] as [number, number, number], heading: defaultHeading(geometry, c, big) };
    }, [geometry, scene.metersPerPixel]);

    return (
        <div id="fp-walkthrough" className="relative w-full h-[60vh] rounded-xl overflow-hidden border border-slate-200 bg-slate-100">
            <Canvas shadows camera={{ fov: 60, position: [center[0] + span * 0.6, span * 0.9, center[2] + span * 0.9] }}>
                <color attach="background" args={['#eef1f4']} />
                <hemisphereLight args={['#ffffff', '#b9b2a6', 0.9]} />
                <directionalLight position={[center[0] + 8, 14, center[2] - 6]} intensity={1.6} castShadow
                    shadow-mapSize={[2048, 2048]} shadow-camera-left={-span} shadow-camera-right={span}
                    shadow-camera-top={span} shadow-camera-bottom={-span} />
                <SceneMeshes scene={scene} ceiling={mode === 'walk'} />
                <Viewpoints geometry={geometry} points={scenePoints} />
                {mode === 'orbit'
                    ? <Overview center={center} span={span} />
                    : <Walker start={start} geometry={geometry} onDrop={onAddViewpoint} dropRef={dropRef}
                        onLock={() => setLocked(true)} onUnlock={() => setLocked(false)} />}
            </Canvas>

            <div className="absolute top-3 left-3 flex gap-2">
                {(['orbit', 'walk'] as const).map(m => (
                    <button key={m} onClick={() => setMode(m)}
                        className={`px-3 py-1.5 text-sm rounded-md shadow ${mode === m ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700'}`}>
                        {t(m === 'orbit' ? 'view3dOrbit' : 'view3dWalk')}
                    </button>
                ))}
                {mode === 'walk' && (
                    <button onClick={() => dropRef.current()} className="px-3 py-1.5 text-sm rounded-md shadow bg-red-600 text-white">
                        {t('dropViewpoint')}
                    </button>
                )}
            </div>
            <div className="absolute bottom-3 left-3 right-3 text-xs text-slate-600 bg-white/80 rounded px-2 py-1">
                {mode === 'orbit' ? t('orbitHint') : locked ? t('walkHintLocked') : t('walkHint')}
            </div>
        </div>
    );
};

const SceneMeshes: React.FC<{ scene: Scene3D; ceiling: boolean }> = ({ scene, ceiling }) => {
    const floors = useMemo(() => scene.floors.map(f => {
        const shape = new THREE.Shape(f.outline.map(([x, z]) => new THREE.Vector2(x, z)));
        const geom = new THREE.ShapeGeometry(shape);
        // Shape lies in x/y; rotate so its y becomes scene +z (plan down).
        geom.rotateX(Math.PI / 2);
        return { key: f.roomId, geom, color: f.color };
    }), [scene]);

    return (
        <group>
            {floors.map(f => (
                <mesh key={f.key} geometry={f.geom} position={[0, 0.001, 0]} receiveShadow>
                    <meshStandardMaterial color={f.color} side={THREE.DoubleSide} roughness={0.8} />
                </mesh>
            ))}
            {ceiling && floors.map(f => (
                <mesh key={`c-${f.key}`} geometry={f.geom} position={[0, scene.ceilingHeight, 0]}>
                    <meshStandardMaterial color="#fbfaf8" side={THREE.DoubleSide} roughness={0.95} />
                </mesh>
            ))}
            {scene.boxes.map((b, i) => (
                <mesh key={i} position={b.center} rotation={[0, b.rotationY, 0]} castShadow={b.kind !== 'glass'} receiveShadow>
                    <boxGeometry args={b.size} />
                    {b.kind === 'glass'
                        ? <meshPhysicalMaterial color={b.color} transparent opacity={0.35} roughness={0.05} />
                        : <meshStandardMaterial color={b.color} roughness={b.kind === 'wall' ? 0.9 : 0.6} />}
                </mesh>
            ))}
        </group>
    );
};

const Viewpoints: React.FC<{ geometry: PlanGeometry; points: ScenePoint[] }> = ({ geometry, points }) => {
    const scene = useMemo(() => buildScene(geometry), [geometry]);
    const mpp = scene.metersPerPixel;
    return (
        <group>
            {points.map((p, i) => {
                const x = p.u * geometry.image.width * mpp, z = p.v * geometry.image.height * mpp;
                const [dx, dz] = p.heading !== undefined ? headingVector(p.heading) : [0, 0];
                return (
                    <group key={i} position={[x, 0, z]}>
                        <mesh position={[0, 0.8, 0]}>
                            <cylinderGeometry args={[0.12, 0.12, 1.6, 16]} />
                            <meshStandardMaterial color="#dc2626" />
                        </mesh>
                        {p.heading !== undefined && (
                            <mesh position={[dx * 0.45, EYE_HEIGHT, dz * 0.45]} rotation={[Math.PI / 2, Math.atan2(dx, dz), 0, 'YXZ']}>
                                <coneGeometry args={[0.15, 0.5, 16]} />
                                <meshStandardMaterial color="#dc2626" />
                            </mesh>
                        )}
                    </group>
                );
            })}
        </group>
    );
};

/** Orbit controls that start from an overview whenever orbit mode is entered. */
const Overview: React.FC<{ center: [number, number, number]; span: number }> = ({ center, span }) => {
    const { camera } = useThree();
    useEffect(() => {
        camera.position.set(center[0] + span * 0.6, span * 0.9, center[2] + span * 0.9);
        camera.lookAt(...center);
    }, [camera, center[0], center[2], span]);
    return <OrbitControls target={center} maxPolarAngle={Math.PI / 2.05} makeDefault />;
};

/** First-person controls: mouse look under pointer lock, WASD/arrows to move, V to drop a viewpoint. */
const Walker: React.FC<{
    start: { position: [number, number, number]; heading: number };
    geometry: PlanGeometry;
    onDrop: (p: ScenePoint) => void;
    dropRef: React.MutableRefObject<() => void>;
    onLock: () => void;
    onUnlock: () => void;
}> = ({ start, geometry, onDrop, dropRef, onLock, onUnlock }) => {
    const { camera } = useThree();
    const keys = useRef<Record<string, boolean>>({});

    useEffect(() => {
        const [x, , z] = start.position;
        const [dx, dz] = headingVector(start.heading);
        camera.position.set(x, EYE_HEIGHT, z);
        camera.lookAt(x + dx, EYE_HEIGHT, z + dz);
    }, [camera, start]);

    useEffect(() => {
        const mpp = buildScene(geometry).metersPerPixel;
        dropRef.current = () => {
            const dir = new THREE.Vector3();
            camera.getWorldDirection(dir);
            const heading = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI;
            onDrop({
                u: camera.position.x / mpp / geometry.image.width,
                v: camera.position.z / mpp / geometry.image.height,
                heading,
            });
        };
        const down = (e: KeyboardEvent) => {
            keys.current[e.code] = true;
            if (e.code === 'KeyV') dropRef.current();
        };
        const up = (e: KeyboardEvent) => { keys.current[e.code] = false; };
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
    }, [camera, geometry, onDrop, dropRef]);

    useFrame((_, delta) => {
        const k = keys.current;
        const speed = (k.ShiftLeft ? 3 : 1.4) * delta;
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
        if (k.KeyW || k.ArrowUp) camera.position.addScaledVector(forward, speed);
        if (k.KeyS || k.ArrowDown) camera.position.addScaledVector(forward, -speed);
        if (k.KeyD || k.ArrowRight) camera.position.addScaledVector(right, speed);
        if (k.KeyA || k.ArrowLeft) camera.position.addScaledVector(right, -speed);
        camera.position.y = EYE_HEIGHT;
    });

    // Lock the pointer only when the 3D view itself is clicked, so the toolbar keeps working.
    return <PointerLockControls selector="#fp-walkthrough canvas" onLock={onLock} onUnlock={onUnlock} />;
};

export default Walkthrough3D;
