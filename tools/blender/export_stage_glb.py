"""Export a stage's terrain tiles, backdrop and unique meshes (bridges) as one GLB.

    blender -b <ue>/Art/Source/Stages/<id>.blend -P tools/blender/export_stage_glb.py -- --stage finland [--out DIR]

Opens the UE project's saved stage .blend read-only (nothing is saved) and writes
<out>/<id>.glb. Node names are the UE mesh names (SM_Finland_Tile_3_4, ...), placed where the
stage JSON puts them; material names are the surface slots (Grass, Gravel, Tarmac, Line, Dirt,
Rock, Water, Flat).
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
from glb import export_glb, ue_root  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
repo, _ = ue_root()
ap = argparse.ArgumentParser()
ap.add_argument('--stage', required=True)
ap.add_argument('--out', default=os.path.join(repo, 'public', 'assets', 'stages'))
a = ap.parse_args(argv)
objs = [o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith('SM_')]
export_glb(objs, os.path.join(os.path.abspath(a.out), a.stage + '.glb'))
