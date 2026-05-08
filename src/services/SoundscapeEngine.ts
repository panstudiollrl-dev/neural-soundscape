import * as Tone from 'tone';
import { SoundLayerVolumes } from '../types';

const DEFAULT_LAYER_VOLUMES: SoundLayerVolumes = {
  deepWater: 1,
  waterStream: 1,
  drone: 1,
  whale: 1,
  drips: 1,
  chimes: 0,
  birds: 1,
};

export class SoundscapeEngine {
  // Ambient Soundscape Layers
  private windNoise: Tone.Noise | null = null;
  private windFilter: Tone.Filter | null = null;
  private waterNoise: Tone.Noise | null = null;
  private waterFilter: Tone.Filter | null = null;
  private waterLFO: Tone.LFO | null = null;
  
  // Synthesizers
  private padSynth: Tone.PolySynth | null = null;
  private chimeSynth: Tone.PolySynth | null = null;
  private whaleSynth: Tone.Synth | null = null;
  private dripSynth: Tone.MembraneSynth | null = null;
  private birdSynth: Tone.Synth | null = null;

  // Effects & Master
  private reverb: Tone.Reverb | null = null;
  private caveReverb: Tone.Reverb | null = null;
  private delay: Tone.PingPongDelay | null = null;
  private masterVol: Tone.Volume | null = null;

  // Music state & timing
  private chimeScale = ["D5", "E5", "G5", "A5", "B5", "D6"];
  private whaleNotes = ["C3", "D3", "A2", "E3"];
  private lastChimeTime = 0;
  private lastWhaleTime = 0;
  private lastDripTime = 0;
  private lastBirdTime = 0;
  private layerVolumes: SoundLayerVolumes = DEFAULT_LAYER_VOLUMES;

  private linearRamp(param: { linearRampTo?: (value: any, rampTime: number) => void; value?: any } | undefined, value: number, rampTime: number) {
    if (!param) return;
    if (typeof param.linearRampTo === "function") {
      param.linearRampTo(value, rampTime);
    } else {
      param.value = value;
    }
  }

  private volumeOffset(volume: number) {
    return volume <= 0 ? -80 : 20 * Math.log10(Math.max(0.001, volume));
  }

  private scaledDb(targetDb: number, volume: number) {
    return volume <= 0 ? -80 : Math.max(-80, targetDb + this.volumeOffset(volume));
  }

  setLayerVolumes(volumes: SoundLayerVolumes) {
    this.layerVolumes = { ...volumes };
    this.linearRamp(this.chimeSynth?.volume, this.scaledDb(-18, volumes.chimes), 0.15);
    this.linearRamp(this.whaleSynth?.volume, this.scaledDb(-10, volumes.whale), 0.15);
    this.linearRamp(this.dripSynth?.volume, this.scaledDb(-15, volumes.drips), 0.15);
    this.linearRamp(this.birdSynth?.volume, this.scaledDb(-25, volumes.birds), 0.15);
  }

  constructor() {
    this.masterVol = new Tone.Volume(-10).toDestination();
    
    // Deep Ocean / Forest Reverb
    this.reverb = new Tone.Reverb({ decay: 5, wet: 0.65 }).connect(this.masterVol);
    // Cave Reverb for drips
    this.caveReverb = new Tone.Reverb({ decay: 3, wet: 0.85 }).connect(this.masterVol);
    this.delay = new Tone.PingPongDelay({ delayTime: "4n", feedback: 0.3, wet: 0.4 }).connect(this.reverb);

    // 1. Lush underwater drone (Delta/Theta base)
    this.padSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sine" },
      envelope: { attack: 8, decay: 4, sustain: 1, release: 10 }
    }).connect(this.reverb);
    this.padSynth.volume.value = -12;

    // 2. Wind Chimes (Alpha)
    this.chimeSynth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.01,
      modulationIndex: 14,
      oscillator: { type: "triangle" },
      envelope: { attack: 0.01, decay: 2, sustain: 0, release: 2 },
      modulation: { type: "square" },
      modulationEnvelope: { attack: 0.01, decay: 1, sustain: 0, release: 1 }
    }).connect(this.delay);
    this.chimeSynth.volume.value = -18;

    // 3. Whale / Dolphin Calls (Delta occasional)
    this.whaleSynth = new Tone.Synth({
      oscillator: { type: "sine" },
      envelope: { attack: 2, decay: 1, sustain: 1, release: 4 }
    }).connect(this.reverb);
    this.whaleSynth.volume.value = -10;

    // 4. Cave Water Drips (Theta occasional)
    this.dripSynth = new Tone.MembraneSynth({
      pitchDecay: 0.008,
      octaves: 3,
      oscillator: { type: "sine" },
      envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.1 }
    }).connect(this.caveReverb);
    this.dripSynth.volume.value = -15;

    // 5. Bird Chirps (Beta occasional)
    this.birdSynth = new Tone.Synth({
      oscillator: { type: "sine" },
      envelope: { attack: 0.02, decay: 0.1, sustain: 0, release: 0.1 }
    }).connect(this.delay);
    this.birdSynth.volume.value = -25;

    // 6. Wind / Ocean Roar (Brown noise)
    this.windNoise = new Tone.Noise("brown").start();
    this.windFilter = new Tone.Filter(200, "lowpass", -24).connect(this.reverb);
    this.windNoise.connect(this.windFilter);
    this.windNoise.volume.value = -80;

    // 7. Hydrophone current (muffled water pressure, not wind-like air noise)
    this.waterNoise = new Tone.Noise("brown").start();
    this.waterFilter = new Tone.Filter(520, "lowpass", -24).connect(this.reverb);
    this.waterNoise.connect(this.waterFilter);
    this.waterNoise.volume.value = -80;
    
    // Slow underwater pressure movement for contact-mic texture.
    this.waterLFO = new Tone.LFO({ frequency: 0.22, min: 160, max: 950 }).start();
    this.waterLFO.connect(this.waterFilter.frequency);
  }

  async start() {
    await Tone.start();
    
    this.setLayerVolumes(this.layerVolumes);
    this.linearRamp(this.windNoise?.volume, this.scaledDb(-60, this.layerVolumes.deepWater), 0.1);
    this.linearRamp(this.waterNoise?.volume, this.scaledDb(-46, this.layerVolumes.waterStream), 0.1);
    this.linearRamp(this.masterVol?.volume, -10, 0.1);
    
    // Start background drone
    this.padSynth?.triggerAttack(["D3", "A3", "F#4"], Tone.now(), 0.05);
    console.log("Ambient Engine Started - Bioluminescence Mode");
  }

  updateFromEEG(delta: number, theta: number, alpha: number, beta: number) {
    if (!this.padSynth || !this.windNoise || !this.waterNoise || !this.windFilter) return;

    const now = Tone.now();
    const shape = (value: number) => Math.pow(Math.max(0, Math.min(1, value)), 0.75);
    const d = shape(delta);
    const t = shape(theta);
    const a = shape(alpha);
    const b = shape(beta);
    const volumes = this.layerVolumes;

    // Delta -> Deep Space / Ocean & Whales
    this.linearRamp(this.windNoise.volume, this.scaledDb(-42 + d * 24, volumes.deepWater), 0.35);
    this.linearRamp(this.windFilter.frequency, 80 + (d * 420), 0.35);
    
    if (volumes.whale > 0 && d > 0.34 && now - this.lastWhaleTime > (12 - d * 6)) {
        const note = this.whaleNotes[Math.floor(Math.random() * this.whaleNotes.length)];
        this.whaleSynth?.triggerAttackRelease(note, 3, now, (0.25 + d * 0.5) * volumes.whale);
        // Subtle pitch bend for whale effect
        this.linearRamp(this.whaleSynth?.frequency, Tone.Frequency(note).transpose(-2).toFrequency(), 3);
        this.lastWhaleTime = now;
    }

    // Theta -> Pad Presence & Cave Drips
    const padVolDb = -28 + (t * 22);
    this.linearRamp(this.padSynth.volume, this.scaledDb(Math.min(-6, padVolDb), volumes.drone), 0.35);

    if (volumes.drips > 0 && t > 0.25 && now - this.lastDripTime > (3.2 - t * 1.8)) {
        const dropFreq = 700 + t * 900 + Math.random() * 500;
        this.dripSynth?.triggerAttackRelease(dropFreq, "16n", now, (0.15 + t * 0.55) * volumes.drips);
        this.lastDripTime = now + Math.random(); // Add irregularity
    }

    // Alpha -> Wind Chimes
    if (volumes.chimes > 0 && a > 0.24 && now - this.lastChimeTime > (2.6 - a * 1.2)) {
      const note = this.chimeScale[Math.floor(Math.random() * this.chimeScale.length)];
      this.chimeSynth?.triggerAttackRelease(note, "2n", now, (0.12 + a * 0.42) * volumes.chimes);
      this.lastChimeTime = now + Math.random() * 0.5;
    }

    // Beta -> submerged current and pressure movement.
    this.linearRamp(this.waterNoise.volume, this.scaledDb(-32 + b * 18 + t * 6, volumes.waterStream), 0.45);
    this.linearRamp(this.waterFilter?.frequency, 180 + b * 760 + t * 320, 0.45);
    this.linearRamp(this.waterLFO?.frequency, 0.08 + b * 1.9 + t * 0.5, 0.45);

    if (volumes.birds > 0 && b > 0.32 && now - this.lastBirdTime > (4 - b * 2.4)) {
        // Double chirp pattern
        const birdPitch = 2400 + b * 1800 + Math.random() * 1000;
        this.birdSynth?.triggerAttackRelease(birdPitch, 0.05, now, (0.08 + b * 0.28) * volumes.birds);
        this.birdSynth?.triggerAttackRelease(birdPitch * 1.1, 0.05, now + 0.1, (0.08 + b * 0.28) * volumes.birds);
        this.lastBirdTime = now + Math.random() * 2;
    }

    // Master volume adjustments
    this.linearRamp(this.masterVol?.volume, -13 + (a * 7), 0.35);
  }

  stop() {
    this.padSynth?.releaseAll();
    this.chimeSynth?.releaseAll();
    this.whaleSynth?.triggerRelease();
    this.linearRamp(this.windNoise?.volume, -80, 1);
    this.linearRamp(this.waterNoise?.volume, -80, 1);
    this.linearRamp(this.masterVol?.volume, -80, 1); // Ensure complete silence
    setTimeout(() => {
        Tone.Transport.stop();
    }, 2000);
  }
}
