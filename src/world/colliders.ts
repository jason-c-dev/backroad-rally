// Colliders for env instances (rocks, trees, buildings, props), the way UE's import set them up
// (RallyEditorLib::SetMeshCollision, from the catalog's `collision`):
// - capsule: radius from the catalog, standing on the pivot (trees, poles);
// - box: the catalog's boxes, else its bounds, else the mesh's own bounding box (the rocks carry
//   no bounds in the catalog, and UE boxed them from the mesh);
// - complex: UE used the mesh itself (complex as simple); here its convex hull, which is solid and
//   has no inside edges to snag on (boulders are near-convex lumps).
// Instance scale and yaw apply. Kept free of the renderer so tests can build the same colliders.
import type RAPIER from '@dimforge/rapier3d-compat';
import { Box3, Quaternion, Vector3, type BufferGeometry } from 'three';
import type { CatalogEntry } from './stage';

export interface MeshPart {
  geometry: BufferGeometry;
}

const boundsCache = new WeakMap<object, Box3>();
/** Bounding box of an env mesh's parts in its local frame (three metres, unscaled). */
export function meshBounds(parts: MeshPart[]): Box3 {
  let b = boundsCache.get(parts);
  if (!b) {
    b = new Box3();
    for (const pt of parts) {
      if (!pt.geometry.boundingBox) pt.geometry.computeBoundingBox();
      b.union(pt.geometry.boundingBox!);
    }
    boundsCache.set(parts, b);
  }
  return b;
}

/** Collider descriptions (placed, rotated) for one instance at (x, y, z), yaw rotY (rad about +Y), scale s. */
export function instanceColliderDescs(rapier: typeof RAPIER, cat: CatalogEntry, parts: MeshPart[],
  x: number, y: number, z: number, rotY: number, s: number): RAPIER.ColliderDesc[] {
  const rot = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rotY);
  const at = (local: Vector3) => local.multiplyScalar(s).applyQuaternion(rot).add(new Vector3(x, y, z));
  const out: RAPIER.ColliderDesc[] = [];
  const add = (desc: RAPIER.ColliderDesc | null, centre: Vector3) => {
    if (desc) out.push(desc.setTranslation(centre.x, centre.y, centre.z).setRotation(rot).setFriction(0.6));
  };
  if (cat.collision === 'capsule') {
    const r = (cat.collision_radius_cm / 100) * s;
    const h = (cat.height_cm / 100) * s;
    add(rapier.ColliderDesc.capsule(Math.max(0.01, h / 2 - r), r), at(new Vector3(0, cat.height_cm / 200, 0)));
  } else if (cat.collision === 'box') {
    // UE local cm (X forward, Y right, Z up) -> three local m (x, z, y)
    const boxes = cat.collision_boxes_cm ?? (cat.bounds_min_cm && cat.bounds_max_cm ? [{
      center: cat.bounds_min_cm.map((v, k) => (v + cat.bounds_max_cm![k]) / 2),
      half: cat.bounds_min_cm.map((v, k) => (cat.bounds_max_cm![k] - v) / 2),
    }] : null);
    if (boxes) {
      for (const b of boxes) {
        add(rapier.ColliderDesc.cuboid((b.half[0] / 100) * s, (b.half[2] / 100) * s, (b.half[1] / 100) * s),
          at(new Vector3(b.center[0] / 100, b.center[2] / 100, b.center[1] / 100)));
      }
    } else {
      const b = meshBounds(parts);
      const half = b.getSize(new Vector3()).multiplyScalar(0.5 * s);
      add(rapier.ColliderDesc.cuboid(Math.max(0.01, half.x), Math.max(0.01, half.y), Math.max(0.01, half.z)),
        at(b.getCenter(new Vector3())));
    }
  } else if (cat.collision === 'complex') {
    const pts: number[] = [];
    const v = new Vector3();
    for (const pt of parts) {
      const pos = pt.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).multiplyScalar(s);
        pts.push(v.x, v.y, v.z);
      }
    }
    add(rapier.ColliderDesc.convexHull(new Float32Array(pts)), new Vector3(x, y, z));
  }
  return out;
}
