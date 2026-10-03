import fs from 'node:fs';
import { PlanGeometrySchema, roomAt } from '../shared/geometry';
import { buildScene, cameraFor, defaultHeading } from '../shared/scene3d';
const g = PlanGeometrySchema.parse(JSON.parse(fs.readFileSync('fixtures/sample-plan.geometry.json', 'utf8')));
const scene = buildScene(g);
const vp = (x: number, y: number, heading?: number) => {
  const h = heading ?? defaultHeading(g, { x, y }, roomAt(g.rooms, { x, y }));
  return cameraFor(g, { u: x / g.image.width, v: y / g.image.height, heading: h }, 75);
};
const job = { scene, light: { mode: 'day', temperature: 5500, sunHeading: 135 }, samples: 64, outDir: '/home/eliot/tmp/fp/blender',
  shots: [
    { name: 'living', kind: 'eye', ...vp(650, 560), width: 1344, height: 768 },
    { name: 'bedroom1', kind: 'eye', ...vp(1200, 470), width: 1344, height: 768 },
    { name: 'top', kind: 'top', width: 1400, height: 1000 },
  ] };
console.log(JSON.stringify(job));
