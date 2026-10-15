"""Export environment meshes (vegetation, props) as one GLB, each at the origin.

    blender -b -P tools/blender/export_env_glb.py -- --meshes SM_Spruce_A,SM_Bush_A --name finland [--out DIR]

Appends the named objects from the UE project's Art/Source/Env/*.blend kits (read-only) into an
empty scene, puts each at the origin with no rotation (the pivot is the base centre, front +X) and
writes <out>/env_<name>.glb with one node per mesh, named after it.
"""
import argparse
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
from glb import export_glb, ue_root  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
repo, ue = ue_root()
ap = argparse.ArgumentParser()
ap.add_argument('--meshes', required=True)
ap.add_argument('--name', required=True)
ap.add_argument('--ue', default=ue)
ap.add_argument('--out', default=os.path.join(repo, 'public', 'assets', 'env'))
a = ap.parse_args(argv)
wanted = set(m for m in a.meshes.split(',') if m)

bpy.ops.wm.read_factory_settings(use_empty=True)
found = []
for path in sorted(glob.glob(os.path.join(os.path.abspath(a.ue), 'Art', 'Source', 'Env', '*.blend'))):
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        names = [n for n in src.objects if n in wanted and n not in found]
        dst.objects = names
    for o in dst.objects:
        if o is None:
            continue
        bpy.context.scene.collection.objects.link(o)
        o.parent = None
        o.location = (0, 0, 0)
        o.rotation_euler = (0, 0, 0)
        found.append(o.name)
missing = sorted(wanted - set(found))
if missing:
    print('MISSING', ' '.join(missing))
objs = [bpy.data.objects[n] for n in sorted(found)]
export_glb(objs, os.path.join(os.path.abspath(a.out), 'env_%s.glb' % a.name))
