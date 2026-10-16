// The car body's contact impulses from Rapier's solver, as the original's hit events gave them
// (OnComponentHit: NormalImpulse, ImpactPoint, ImpactNormal). Read once per physics step, before the
// next step runs, from the contact pairs the last step left: one hit per pair touching the chassis,
// sized by the summed normal impulse over the car's mass (km/h). Reading never touches the simulation.
import type RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import type { Vehicle } from '../sim/vehicle';
import type { Hit } from './damage';

export class BodyContacts {
  /** Largest pair impulse seen (km/h of velocity change), for checks. */
  maxKmh = 0;
  private chassis: RAPIER.Collider;
  private n = new Vector3();
  private imp = new Vector3();
  private pt = new Vector3();
  private v = { x: 0, y: 0, z: 0 };
  private prevP = new Vector3(1e9, 0, 0);

  constructor(private world: RAPIER.World, private veh: Vehicle, private groundNormalY = 0.7) {
    this.chassis = veh.body.collider(0);
  }

  /** Every pair's hit since the last call (none right after a teleport). */
  read(out: Hit[] = []): Hit[] {
    out.length = 0;
    const veh = this.veh;
    const p = veh.position;
    const jump = Math.max(4, veh.velocity.length() * 0.05);
    const teleported = p.distanceToSquared(this.prevP) > jump * jump;
    this.prevP.copy(p);
    if (teleported) return out;
    const mass = Math.max(100, veh.t.massKg);
    const upright = veh.up.y > 0.5;
    const col = this.chassis;
    const off = col.translationWrtParent?.() ?? { x: 0, y: 0, z: 0 };
    this.world.contactPairsWith(col, (other) => {
      this.imp.set(0, 0, 0);
      this.pt.set(0, 0, 0);
      let total = 0;
      this.world.contactPair(col, other, (m, flipped) => {
        const k = m.numContacts();
        if (!k) return;
        let sum = 0;
        for (let i = 0; i < k; i++) {
          const j = m.contactImpulse(i);
          if (j <= 0) continue;
          sum += j;
          // the point on the chassis, in the collider's (= the car's) frame
          const lp = flipped ? m.localContactPoint2(i, this.v) : m.localContactPoint1(i, this.v);
          if (lp) this.pt.add(this.n.set(lp.x + off.x, lp.y + off.y, lp.z + off.z).multiplyScalar(j));
        }
        if (sum <= 0) return;
        // world normal from collider 1 to 2; the hit normal points from what was hit toward the car
        const wn = m.normal(this.v);
        const s = flipped ? 1 : -1;
        this.imp.addScaledVector(this.n.set(wn.x * s, wn.y * s, wn.z * s), sum);
        total += sum;
      });
      if (total <= 0) return;
      const len = this.imp.length();
      const kmh = (len / mass) * 3.6;
      this.maxKmh = Math.max(this.maxKmh, kmh);
      const n = this.n.copy(this.imp).multiplyScalar(1 / Math.max(1e-9, len));
      this.pt.multiplyScalar(1 / total);
      // car frame: three x = forward, z = right (UE y)
      out.push({
        kmh,
        x: this.pt.x * 100,
        y: this.pt.z * 100,
        ny: n.dot(veh.right),
        ground: n.y > this.groundNormalY && upright,
        what: other.isSensor() ? 'sensor' : undefined,
      });
    });
    return out;
  }
}
