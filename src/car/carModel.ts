// A car GLB from tools/blender/export_car_glb.py: one body mesh with the material slots
// as glTF materials, and four wheel nodes (wheel_fl/fr/rl/rr) with their origin at the
// wheel centre. Paint1/2/3 and Rim vertices are white; the livery colours them.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CarData, Livery } from '../data';
import { loadGlb } from '../data';
import { cm } from '../ue';
import { carMaterial } from '../look/materials';

export type WheelKey = 'fl' | 'fr' | 'rl' | 'rr';
export const WHEELS: WheelKey[] = ['fl', 'fr', 'rl', 'rr'];

export interface CarModel {
  root: THREE.Group;
  wheels: Record<WheelKey, THREE.Object3D>;
  wheelRadius: number;
  setLivery(l: Livery): void;
  /** Paint lerped toward `dirt` by `amount` 0..1 (the original's SetPaintGrime: damage and dust; rims stay clean). */
  setGrime(amount: number, dirt: string): void;
  /** Front-wheel angle (rad, + = right) and each wheel's spin angle (rad) and suspension compression (m). */
  pose(steer: number, wheels: { angle: number; compression: number }[]): void;
}

const loader = new GLTFLoader();

export async function loadCarModel(car: CarData): Promise<CarModel> {
  const gltf = await loadGlb(loader, `assets/cars/${car.id}.glb`);
  const root = new THREE.Group();
  root.name = car.id;
  root.add(gltf.scene);

  const mats = new Map<string, THREE.MeshStandardNodeMaterial>();
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const old = mesh.material as THREE.Material;
    const slot = old.name;
    if (!mats.has(slot)) mats.set(slot, carMaterial(slot));
    mesh.material = mats.get(slot)!;
    old.dispose();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });

  const wheels = {} as Record<WheelKey, THREE.Object3D>;
  for (const k of WHEELS) {
    const w = gltf.scene.getObjectByName(`wheel_${k}`);
    if (!w) throw new Error(`${car.id}.glb: no wheel_${k}`);
    w.rotation.order = 'YZX'; // steer about Y after spinning about the axle (Z)
    w.userData.restY = w.position.y;
    wheels[k] = w;
  }

  let livery = car.liveries[0];
  let grime = 0;
  let dirtHex = '';
  const dirtColor = new THREE.Color();
  // paint lerps toward the dirt in linear colour, as UE's FMath::Lerp on FLinearColor did
  const paint = (slot: string, hex: string) => mats.get(slot)?.color.set(hex).lerp(dirtColor, grime);
  const model: CarModel = {
    root,
    wheels,
    wheelRadius: cm(car.wheel_radius_cm),
    setLivery(l) {
      livery = l;
      paint('Paint1', l.paint1);
      paint('Paint2', l.paint2);
      paint('Paint3', l.paint3);
      mats.get('Rim')?.color.set(l.rim);
    },
    setGrime(amount, dirt) {
      amount = Math.min(Math.max(amount, 0), 1);
      if (Math.abs(amount - grime) < 0.002 && dirt === dirtHex) return;
      grime = amount;
      dirtHex = dirt;
      dirtColor.set(dirt);
      model.setLivery(livery);
    },
    pose(steer, state) {
      WHEELS.forEach((k, i) => {
        const w = wheels[k];
        w.rotation.z = -state[i].angle; // rolling forward (+X) turns the wheel about -Z
        w.rotation.y = k[0] === 'f' ? -steer : 0;
        w.position.y = w.userData.restY + state[i].compression;
      });
    },
  };
  model.setLivery(car.liveries[0]);
  return model;
}
