"""Build a car with the UE project's generator and export it as GLB for the web.

    blender -b -P tools/blender/export_car_glb.py -- --car swift [--ue ../BackroadRally] [--out public/assets/cars]

Reads the generator in <ue>/Art/Scripts/cars (read-only: no bytecode or files are written
there) and writes <out>/<id>.glb. Differences from the UE export:
- the four wheels are separate child nodes `wheel_fl/fr/rl/rr` with their origin at the
  wheel centre, so the game spins and steers them directly (no skinning);
- glTF Y-up in metres: Blender (x, y, z) -> three (x, z, -y), car forward = three +X;
- material names are the slot names (Paint1/2/3, Glass, Trim, Chrome, LightFront,
  LightRear, Tyre, Rim); vertex colours carry the nominal colours (Paint and Rim white).
"""
import argparse
import importlib
import os
import sys

sys.dont_write_bytecode = True

import bpy  # noqa: E402

WHEELS = ('fl', 'fr', 'rl', 'rr')


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, '..', '..'))
    ap = argparse.ArgumentParser()
    ap.add_argument('--car', default='swift', help='car id, comma list, or all')
    ap.add_argument('--ue', default=os.environ.get('BR_UE_ROOT', os.path.join(repo, '..', 'BackroadRally')))
    ap.add_argument('--out', default=os.path.join(repo, 'public', 'assets', 'cars'))
    return ap.parse_args(argv)


def split_wheels(ob, ck, d):
    """Separate each wheel_* vertex group into its own object parented to the body."""
    bpy.context.view_layer.objects.active = ob
    wheels = {}
    for wk in WHEELS:
        name = 'wheel_' + wk
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        gi = ob.vertex_groups[name].index
        me = ob.data
        sel = [any(g.group == gi and g.weight > 0.5 for g in v.groups) for v in me.vertices]
        for v in me.vertices:
            v.select = sel[v.index]
        for e in me.edges:
            e.select = all(sel[i] for i in e.vertices)
        for p in me.polygons:
            p.select = all(sel[i] for i in p.vertices)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.separate(type='SELECTED')
        bpy.ops.object.mode_set(mode='OBJECT')
        w = [o for o in bpy.context.selected_objects if o is not ob][0]
        w.name = name
        w.data.name = name
        c = ck.wheel_centre(d, wk)
        # origin to the wheel centre
        bpy.context.scene.cursor.location = c
        bpy.ops.object.select_all(action='DESELECT')
        w.select_set(True)
        bpy.context.view_layer.objects.active = w
        bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
        w.parent = ob
        w.matrix_parent_inverse = ob.matrix_world.inverted()
        w.vertex_groups.clear()
        wheels[wk] = w
    ob.vertex_groups.clear()
    return wheels


def export_car(ck, cid, out_dir):
    d = importlib.import_module('defs.' + cid)
    car, ob, arm, counts = ck.build(d)
    ob.modifiers.clear()
    bpy.data.objects.remove(arm)
    ob.name = cid
    wheels = split_wheels(ob, ck, d)
    # drop unused material slots so the GLB has one primitive per used slot only
    for o in [ob] + list(wheels.values()):
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.ops.object.material_slot_remove_unused()
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    for w in wheels.values():
        w.select_set(True)
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, cid + '.glb')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_yup=True,
        export_normals=True, export_apply=True, export_materials='EXPORT',
        export_vertex_color='ACTIVE', export_all_vertex_colors=False,
        export_texcoords=False, export_tangents=False, export_animations=False,
        export_skins=False, export_cameras=False, export_lights=False, export_extras=False)
    print('GLB %s %d bytes, slots=%s' % (path, os.path.getsize(path), counts))


def main():
    a = args()
    cars_dir = os.path.join(os.path.abspath(a.ue), 'Art', 'Scripts', 'cars')
    if not os.path.isdir(cars_dir):
        sys.exit('car generator not found: %s (pass --ue or set BR_UE_ROOT)' % cars_dir)
    sys.path.insert(0, cars_dir)
    import carkit as ck
    ids = ['swift', 'pip', 'lama', 'quint', 'kaze'] if a.car == 'all' else a.car.split(',')
    for cid in ids:
        export_car(ck, cid, os.path.abspath(a.out))


main()
