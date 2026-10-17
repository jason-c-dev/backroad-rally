// The garage's padlock over a locked car or livery (UE verify-3: SM_Padlock from Art/Scripts/ui/padlock.py, drawn
// after the depth of field so the locked car's blur leaves it sharp). Built here from the same measurements: a
// brass body 44 x 36 x 18 cm with a keyhole, a steel shackle; it turns (padlock_turn_deg_s) and bobs
// (padlock_bob_cm at padlock_bob_hz) padlock_z_cm above the car's top. It is its own little scene, drawn by its own
// small WebGL2 renderer into a transparent canvas over the game's (a second pass into the game's canvas after the
// post chain lost the frame under it on the WebGL2 backend), so the depth of field never touches it.
import * as THREE from 'three/webgpu';

const BW = 0.44, BD = 0.18, BH = 0.36;
const R = 0.135, TUBE = 0.036, LEG = 0.07;

export interface PadlockCfg {
  padlock_z_cm: number;
  padlock_scale: number;
  padlock_turn_deg_s: number;
  padlock_bob_cm: number;
  padlock_bob_hz: number;
}

function mat(hex: string, metal: number, rough: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(hex), metalness: metal, roughness: rough });
  m.flatShading = true;
  return m;
}

export class Padlock {
  readonly scene = new THREE.Scene();
  readonly group = new THREE.Group();
  visible = false;
  private t = 0;
  private yaw = 0;
  /** World point the padlock floats over (the car's top centre). */
  readonly anchor = new THREE.Vector3();

  constructor(private cfg: PadlockCfg) {
    const brass = mat('#F2D06C', 0.05, 0.5);
    const steel = mat('#C9CED6', 0.3, 0.4);
    const hole = mat('#2B2219', 0, 0.8);
    const body = new THREE.Mesh(new THREE.BoxGeometry(BW, BH, BD), brass);
    this.group.add(body);
    // keyhole on both faces (it turns all the way round)
    for (const side of [1, -1]) {
      const kh = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.034, 10), hole);
      disc.position.y = 0.03;
      kh.add(disc);
      const slot = new THREE.Shape([new THREE.Vector2(-0.015, 0.02), new THREE.Vector2(0.015, 0.02), new THREE.Vector2(0.024, -0.075), new THREE.Vector2(-0.024, -0.075)]);
      kh.add(new THREE.Mesh(new THREE.ShapeGeometry(slot), hole));
      kh.position.z = side * (BD / 2 + 0.002);
      if (side < 0) kh.rotation.y = Math.PI;
      this.group.add(kh);
    }
    // shackle: two legs and a half circle, swept as a tube
    const z0 = BH / 2 + LEG;
    const pts = [new THREE.Vector3(-R, BH / 2 - 0.06, 0), new THREE.Vector3(-R, z0, 0)];
    const N = 10;
    for (let i = 1; i < N; i++) {
      const a = Math.PI - (Math.PI * i) / N;
      pts.push(new THREE.Vector3(R * Math.cos(a), z0 + R * Math.sin(a), 0));
    }
    pts.push(new THREE.Vector3(R, z0, 0), new THREE.Vector3(R, BH / 2 - 0.06, 0));
    const path = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1);
    this.group.add(new THREE.Mesh(new THREE.TubeGeometry(path, 40, TUBE, 8, false), steel));
    this.group.scale.setScalar(cfg.padlock_scale);
    this.scene.add(this.group);
    this.scene.add(new THREE.HemisphereLight('#fff6e8', '#5a5048', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 2.4);
    sun.position.set(-3, 5, 2);
    this.scene.add(sun);
  }

  /** The car's top (world): the padlock's anchor. */
  placeOver(root: THREE.Object3D): void {
    const b = new THREE.Box3().setFromObject(root);
    const c = b.getCenter(new THREE.Vector3());
    this.anchor.set(c.x, b.max.y, c.z);
  }

  update(dt: number): void {
    this.t += dt;
    this.yaw = (this.yaw + this.cfg.padlock_turn_deg_s * dt) % 360;
    const bob = (this.cfg.padlock_bob_cm / 100) * Math.sin(this.t * 2 * Math.PI * this.cfg.padlock_bob_hz);
    this.group.position.copy(this.anchor);
    this.group.position.y += this.cfg.padlock_z_cm / 100 + bob;
    this.group.rotation.y = (this.yaw * Math.PI) / 180;
  }

  private renderer: THREE.WebGPURenderer | null = null;
  private ready = false;
  /** Its renderer couldn't start: the padlock joins the game's scene instead (blurred with the car, but there). */
  private failed = false;
  /** The game's renderer backend (the overlay uses the same kind) and scene (the fallback). */
  forceWebGL = true;
  fallbackScene: THREE.Scene | null = null;

  /** Over the finished frame, with the game camera; nothing while hidden (the canvas hides too). */
  render(camera: THREE.PerspectiveCamera): void {
    if (this.failed) {
      this.group.visible = this.visible;
      return;
    }
    if (!this.visible) {
      if (this.renderer) this.renderer.domElement.style.display = 'none';
      return;
    }
    if (!this.renderer) {
      const r = (this.renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true, forceWebGL: this.forceWebGL }));
      r.setClearColor(0x000000, 0);
      const c = r.domElement;
      c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:5';
      document.body.appendChild(c);
      void r.init().then(() => (this.ready = true)).catch(() => {
        this.failed = true;
        c.remove();
        this.fallbackScene?.add(this.group);
      });
    }
    const r = this.renderer;
    if (!this.ready) return;
    r.domElement.style.display = '';
    const pr = Math.min(devicePixelRatio, 2);
    if (r.getPixelRatio() !== pr) r.setPixelRatio(pr);
    const size = r.getSize(new THREE.Vector2());
    if (size.x !== innerWidth || size.y !== innerHeight) r.setSize(innerWidth, innerHeight, false);
    r.render(this.scene, camera);
  }
}
