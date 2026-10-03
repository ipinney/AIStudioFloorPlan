# SPDX-License-Identifier: Apache-2.0
"""Render a FloorPlan scene with Cycles.

Usage: blender -b --factory-startup -P blender/render_scene.py -- job.json

job.json:
  scene:   shared/scene3d.ts Scene3D (meters; x right, y up, z down the plan)
  shots:   [{name, kind: "eye"|"top", position?, target?, fov?, width, height}]
  light:   {mode: "day"|"night", temperature: K, sunHeading: deg}
  samples: int
  outDir:  directory for <name>.png

Scene axes are three.js-style (y up). Blender is z up, so (x, y, z) maps to
(x, -z, y), and a rotation about scene +y by t is a rotation about Blender +z by t.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector


def to_b(v):
    return Vector((v[0], -v[2], v[1]))


def hex_rgba(h):
    """CSS hex (sRGB) to Blender's linear RGBA."""
    h = h.lstrip('#')
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return tuple(lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)


def kelvin_rgb(k):
    """Approximate blackbody color (Tanner Helland), linear-ish 0..1."""
    t = k / 100.0
    r = 255 if t <= 66 else 329.698727446 * ((t - 60) ** -0.1332047592)
    g = 99.4708025861 * math.log(t) - 161.1195681661 if t <= 66 else 288.1221695283 * ((t - 60) ** -0.0755148492)
    b = 255 if t >= 66 else (0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307)
    return tuple(max(0, min(255, c)) / 255 for c in (r, g, b))


_materials = {}


def material(color, kind='matte'):
    key = (color, kind)
    if key in _materials:
        return _materials[key]
    m = bpy.data.materials.new(f'{kind}-{color}')
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = hex_rgba(color)
    if kind == 'glass':
        p.inputs['Roughness'].default_value = 0.02
        p.inputs['Transmission Weight'].default_value = 1.0
        p.inputs['IOR'].default_value = 1.45
    elif kind == 'floor':
        p.inputs['Roughness'].default_value = 0.55
    elif kind == 'furniture':
        p.inputs['Roughness'].default_value = 0.6
    else:
        p.inputs['Roughness'].default_value = 0.9
    _materials[key] = m
    return m


def add_box(b):
    sx, sy, sz = b['size']  # scene: x length, y height, z depth
    bpy.ops.mesh.primitive_cube_add(size=1, location=to_b(b['center']))
    o = bpy.context.active_object
    o.scale = (sx, sz, sy)
    o.rotation_euler = (0, 0, b['rotationY'])
    kind = 'glass' if b['kind'] == 'glass' else ('furniture' if b['kind'] == 'furniture' else 'matte')
    o.data.materials.append(material(b['color'], kind))
    if b['kind'] == 'glass':
        o.visible_shadow = False
    return o


def add_polygon(outline, height, mat, name):
    mesh = bpy.data.meshes.new(name)
    verts = [(x, -z, height) for x, z in outline]
    mesh.from_pydata(verts, [], [list(range(len(verts)))])
    mesh.update()
    o = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(o)
    o.data.materials.append(mat)
    return o


def setup_world(light, bounds):
    world = bpy.data.worlds.new('World')
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    if light['mode'] == 'day':
        sky = world.node_tree.nodes.new('ShaderNodeTexSky')
        sky.sky_type = 'NISHITA'
        sky.sun_elevation = math.radians(35)
        sky.sun_rotation = math.radians(light.get('sunHeading', 135))
        world.node_tree.links.new(sky.outputs['Color'], bg.inputs['Color'])
        bg.inputs['Strength'].default_value = 0.35
        bpy.ops.object.light_add(type='SUN')
        sun = bpy.context.active_object
        sun.data.energy = 3.5
        sun.data.angle = math.radians(2)
        sun.data.color = kelvin_rgb(light.get('temperature', 5500))
        sun.rotation_euler = (math.radians(55), 0, math.radians(light.get('sunHeading', 135)))
    else:
        bg.inputs['Color'].default_value = (0.01, 0.012, 0.02, 1)
        bg.inputs['Strength'].default_value = 1.0


def add_room_lights(floors, ceiling, light):
    """Soft ceiling panel per room: fill light by day, the main light at night."""
    day = light['mode'] == 'day'
    color = kelvin_rgb(light.get('temperature', 5500 if day else 3000))
    for f in floors:
        xs = [p[0] for p in f['outline']]
        zs = [p[1] for p in f['outline']]
        w, d = max(xs) - min(xs), max(zs) - min(zs)
        if w < 0.5 or d < 0.5:
            continue
        cx, cz = (max(xs) + min(xs)) / 2, (max(zs) + min(zs)) / 2
        bpy.ops.object.light_add(type='AREA', location=(cx, -cz, ceiling - 0.05))
        l = bpy.context.active_object
        l.data.shape = 'RECTANGLE'
        l.data.size, l.data.size_y = w * 0.6, d * 0.6
        # Watts per square meter of room: a gentle fill by day, the main source at night.
        l.data.energy = (5 if day else 18) * w * d
        l.data.color = color


def add_camera(shot, scene3d):
    cam_data = bpy.data.cameras.new(shot['name'])
    cam = bpy.data.objects.new(shot['name'], cam_data)
    bpy.context.collection.objects.link(cam)
    if shot['kind'] == 'top':
        (x0, z0), (x1, z1) = scene3d['bounds']['min'], scene3d['bounds']['max']
        cam_data.type = 'ORTHO'
        aspect = shot['width'] / shot['height']
        w, d = (x1 - x0) * 1.06, (z1 - z0) * 1.06
        cam_data.ortho_scale = max(w, d * aspect)
        cam.location = ((x0 + x1) / 2, -(z0 + z1) / 2, 30)
        cam.rotation_euler = (0, 0, 0)
        cam_data.clip_end = 100
    else:
        cam_data.sensor_fit = 'HORIZONTAL'
        cam_data.angle = math.radians(shot.get('fov', 75))
        cam_data.clip_start = 0.05
        pos, target = to_b(shot['position']), to_b(shot['target'])
        cam.location = pos
        cam.rotation_euler = (target - pos).to_track_quat('-Z', 'Y').to_euler()
    return cam


def use_gpu():
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA'):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            if any(d.type == kind for d in prefs.devices):
                for d in prefs.devices:
                    d.use = d.type == kind
                bpy.context.scene.cycles.device = 'GPU'
                return kind
        except TypeError:
            continue
    return 'CPU'


def main():
    job = json.load(open(sys.argv[sys.argv.index('--') + 1]))
    scene3d = job['scene']
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    device = use_gpu()
    sc.cycles.samples = job.get('samples', 96)
    # Some distro builds (spark's arm64 Blender 4.0) ship without OpenImageDenoise;
    # the Qwen-Edit finishing pass cleans residual noise either way.
    sc.cycles.use_denoising = bool(getattr(bpy.app.build_options, 'openimagedenoise', False))
    if sc.cycles.use_denoising:
        sc.cycles.denoiser = 'OPENIMAGEDENOISE'
    sc.cycles.max_bounces = 6
    sc.view_settings.view_transform = 'AgX' if 'AgX' in [i.identifier for i in sc.view_settings.bl_rna.properties['view_transform'].enum_items] else 'Filmic'
    sc.render.image_settings.file_format = 'PNG'

    for b in scene3d['boxes']:
        add_box(b)
    for f in scene3d['floors']:
        add_polygon(f['outline'], 0.0, material(f['color'], 'floor'), f'floor-{f["roomId"]}')

    light = job.get('light', {'mode': 'day'})
    setup_world(light, scene3d['bounds'])
    add_room_lights(scene3d['floors'], scene3d['ceilingHeight'], light)

    ceilings = [add_polygon(f['outline'], scene3d['ceilingHeight'], material('#fbfaf8'), f'ceiling-{f["roomId"]}')
                for f in scene3d['floors']]

    os.makedirs(job['outDir'], exist_ok=True)
    for shot in job['shots']:
        # Top-down views look into the rooms, so hide the ceilings for them.
        for c in ceilings:
            c.hide_render = shot['kind'] == 'top'
        cam = add_camera(shot, scene3d)
        sc.camera = cam
        sc.render.resolution_x, sc.render.resolution_y = shot['width'], shot['height']
        sc.render.filepath = os.path.join(job['outDir'], f"{shot['name']}.png")
        bpy.ops.render.render(write_still=True)
        print(f'FLOORPLAN_RENDERED {shot["name"]} device={device}', flush=True)


main()
