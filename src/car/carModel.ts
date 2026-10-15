// A car GLB from tools/blender/export_car_glb.py: one body mesh with the material slots
// as glTF materials, and four wheel nodes (wheel_fl/fr/rl/rr) with their origin at the
// wheel centre. Paint1/2/3 and Rim vertices are white; the livery colours them.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CarData, Livery } from '../data';
import { assetUrl } from '../data';
import { cm } from '../ue';

export type WheelKey = 'fl' | 'fr' | 'rl' | 'rr';
export const WHEELS: WheelKey[] = ['fl', 'fr', 'rl', 'rr'];

export interface CarModel {
  root: THREE.Group;
  wheels: Record<WheelKey, THREE.Object3D>;
  wheelRadius: number;
  setLivery(l: Livery): void;
  /** Front-wheel steer angle (rad, + = right) and wheel spin increment (rad). */
  pose(steer: number, spin: number): void;
}

function slotMaterial(slot: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 });
  m.name = slot;
  switch (slot) {
    case 'Glass':
      m.roughness = 0.15;
      break;
    case 'Chrome':
      m.roughness = 0.25;
      m.metalness = 0.8;
      break;
    case 'Tyre':
      m.roughness = 0.95;
      break;
    case 'LightFront':
    case 'LightRear':
      m.roughness = 0.3;
      break;
  }
  return m;
}

const loader = new GLTFLoader();

export async function loadCarModel(car: CarData): Promise<CarModel> {
  const gltf = await loader.loadAsync(assetUrl(`cars/${car.id}.glb`));
  const root = new THREE.Group();
  root.name = car.id;
  root.add(gltf.scene);

  const mats = new Map<string, THREE.MeshStandardMaterial>();
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const old = mesh.material as THREE.Material;
    const slot = old.name;
    if (!mats.has(slot)) mats.set(slot, slotMaterial(slot));
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
    wheels[k] = w;
  }

  const tint = (slot: string, hex: string) => mats.get(slot)?.color.set(hex);
  const model: CarModel = {
    root,
    wheels,
    wheelRadius: cm(car.wheel_radius_cm),
    setLivery(l) {
      tint('Paint1', l.paint1);
      tint('Paint2', l.paint2);
      tint('Paint3', l.paint3);
      tint('Rim', l.rim);
    },
    pose(steer, spin) {
      for (const k of WHEELS) {
        const w = wheels[k];
        w.rotation.z -= spin; // rolling forward (+X) turns the wheel about -Z
        w.rotation.y = k[0] === 'f' ? -steer : 0;
      }
    },
  };
  model.setLivery(car.liveries[0]);
  return model;
}
