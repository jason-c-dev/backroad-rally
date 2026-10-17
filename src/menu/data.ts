// The menus' data (public/data/menu.json, garage.json, career.json: the original's Content/Data) and the
// lookups the screens share: stage names, flags, the diorama's location config, lock lines.
import { load, loadCar, type CarData, type Livery } from '../data';
import type { ConditionsJson } from '../look/conditions';
import type { WeatherJson } from '../game/weather';
import { CareerRules, type CareerJson } from '../game/career';

export interface MenuStage {
  id: string;
  name: string;
  location: string;
  surface: string;
  km_fwd: number;
  km_rev: number;
}

export interface DioramaLocation {
  stage: string;
  reverse: boolean;
  /** Metres along the road. */
  s: number;
  lateral_m: number;
  yaw_offset: number;
  condition: string;
  weather?: string;
  start_yaw: number;
}

export interface OrbitView {
  dist_m: number;
  pitch: number;
  fov_v: number;
  shift_cm: number;
}

export interface MenuJson {
  stages: MenuStage[];
  flags: Record<string, string>;
  groups: { id: string; name: string; era: string }[];
  conditions: string[];
  quick_damage_level: number;
  controls: [string, string, string][];
  diorama: DioramaLocation & {
    location: string;
    swap_debounce_s: number;
    locations: Record<string, Partial<DioramaLocation>>;
    turn_deg_s: number;
    locked: { style: string; focus_past_cm: number; fstop: number; padlock_z_cm: number; padlock_scale: number; padlock_turn_deg_s: number; padlock_bob_cm: number; padlock_bob_hz: number };
    look?: { any?: { by_condition?: { night?: { scale?: { headlights?: { props?: { Intensity?: number; AttenuationRadius?: number } } } } } } };
    views: { fit_length_cm: number; title: OrbitView; garage: OrbitView };
  };
}

export interface GarageCar {
  id: string;
  power: string;
  engine: string;
  drivetrain: string;
  gears: string;
  weight: string;
  era: string;
  bio: string;
}

export type { CareerJson };

export type CarInfo = CarData & { liveries: (Livery & { bonus?: boolean })[] };

export interface MenuData {
  menu: MenuJson;
  garage: GarageCar[];
  career: CareerJson;
  conditions: ConditionsJson;
  weather: WeatherJson;
  cars: CarInfo[];
}

export const CAR_IDS = ['swift', 'pip', 'lama', 'quint', 'kaze'];

export async function loadMenuData(): Promise<MenuData> {
  const [menu, garage, career, conditions, weather, ...cars] = await Promise.all([
    load<MenuJson>('menu.json'),
    load<{ cars: GarageCar[] }>('garage.json'),
    load<CareerJson>('career.json'),
    load<ConditionsJson>('conditions.json'),
    load<WeatherJson>('weather.json'),
    ...CAR_IDS.map((id) => loadCar(id)),
  ]);
  return { menu, garage: garage.cars, career, conditions, weather, cars: cars as CarInfo[] };
}

export const stageMeta = (d: MenuData, id: string): MenuStage | undefined => d.menu.stages.find((s) => s.id === id);

export const km = (s: MenuStage | undefined, reverse: boolean): number => (s ? (reverse ? s.km_rev : s.km_fwd) : 3);

export const groupName = (d: MenuData, g: string): string => d.menu.groups.find((x) => x.id === g)?.name ?? `group ${g}`;

/** The stage's own time of day for a direction (conditions.json stage_defaults, UE DefaultConditionFor). */
export function stageCondition(d: MenuData, stage: string, reverse: boolean): string {
  return d.conditions.stage_defaults[stage]?.[reverse ? 'rev' : 'fwd'] ?? d.conditions.default_condition;
}

/** The stage's own weather for a direction (weather.json stage_defaults, UE RallyWeather::DefaultFor). */
export function stageWeather(d: MenuData, stage: string, reverse: boolean): string {
  return d.weather.stage_defaults[stage]?.[reverse ? 'rev' : 'fwd'] ?? 'clear';
}

/** menu.json diorama with diorama.locations.<location> over it (UE LocationConfig). */
export function dioramaConfig(menu: MenuJson, location: string): DioramaLocation {
  const d = menu.diorama;
  const loc = d.locations[location];
  const base: DioramaLocation = {
    stage: d.stage, reverse: d.reverse, s: d.s, lateral_m: d.lateral_m, yaw_offset: d.yaw_offset, condition: d.condition, start_yaw: d.start_yaw,
  };
  if (loc) return { ...base, ...loc };
  // a location without its own entry: its first stage, at the default s and condition
  const first = menu.stages.find((s) => s.location === location || s.id === location);
  return first ? { ...base, stage: first.id } : base;
}

export const locationOf = (d: MenuData, stage: string): string => stageMeta(d, stage)?.location ?? stage;

/** The garage's lock line: which season unlocks a car (UE BuildGarage). */
export function lockLine(d: MenuData, car: string, carLocked: boolean): string {
  if (!carLocked) return 'locked livery: a career podium with this car\'s group unlocks it.';
  const season = d.career.seasons.find((s) => s.unlock_cars.includes(car));
  return `locked: finish ${season ? `the ${groupName(d, season.group)} season` : 'an earlier season'} of the career to unlock it.`;
}

/** The career's rules over career.json and the menus' stages, cars and groups (src/game/career.ts). */
export function careerRules(d: MenuData): CareerRules {
  return new CareerRules(d.career, {
    stages: d.menu.stages, cars: d.cars, groups: d.menu.groups, defaultWeather: (stage, reverse) => stageWeather(d, stage, reverse),
  });
}

/** Spec sheet of a car (garage.json). */
export const garageCar = (d: MenuData, id: string): GarageCar | undefined => d.garage.find((c) => c.id === id);
