"""Shared GLB export for the web (handoff §4.1): glTF Y-up in metres, so Blender (x, y, z) is
three (x, z, -y); flat shading kept as split normals; material names are the slot names; the
face-corner colour attribute `Col` becomes COLOR_0 (vertex alpha = sway weight on vegetation)."""
import os
import sys

import bpy

sys.dont_write_bytecode = True


def ue_root(default_rel='../BackroadRally'):
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, '..', '..'))
    return repo, os.environ.get('BR_UE_ROOT', os.path.join(repo, default_rel))


def export_glb(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_yup=True,
        export_normals=True, export_apply=True, export_materials='EXPORT',
        export_vertex_color='ACTIVE', export_all_vertex_colors=False,
        export_texcoords=False, export_tangents=False, export_animations=False,
        export_skins=False, export_cameras=False, export_lights=False, export_extras=False)
    print('GLB %s %d bytes, %d objects' % (path, os.path.getsize(path), len(objs)))
