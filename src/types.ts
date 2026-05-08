export interface BrainwaveData {
  delta: number; // 0.5 - 4 Hz: Deep sleep
  theta: number; // 4 - 8 Hz: Meditation/Dreaming
  alpha: number; // 8 - 14 Hz: Relaxation/Visualization
  beta: number;  // 14 - 30 Hz: Alertness/Focus
}

export interface SoundLayerVolumes {
  deepWater: number;
  waterStream: number;
  drone: number;
  whale: number;
  drips: number;
  chimes: number;
  birds: number;
}

export interface AtmosphereConfig {
  windIntensity: number;
  rainIntensity: number;
  forestDensity: number;
  meditationDepth: number;
}
