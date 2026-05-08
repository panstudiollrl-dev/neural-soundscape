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
  private hydroCrackleSynth: Tone.NoiseSynth | null = null;
  private waterCavitySynths: Tone.Synth[] = [];

  // Effects & Master
  private reverb: Tone.Reverb | null = null;
  private caveReverb: Tone.Reverb | null = null;
  private delay: Tone.PingPongDelay | null = null;
  private dripDelay: Tone.PingPongDelay | null = null;
  private masterVol: Tone.Volume | null = null;

  // Music state & timing
  private chimeScale = ["D5", "E5", "G5", "A5", "B5", "D6"];
  private whaleNotes = ["C3", "D3", "A2", "E3"];
  private lastChimeTime = 0;
  private lastWhaleTime = 0;
  private lastDripTime = 0;
  private lastBirdTime = 0;
  private lastCrackleTime = 0;
  private waterCavityVoice = 0;
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
    this.linearRamp(this.hydroCrackleSynth?.volume, this.scaledDb(-34, volumes.waterStream), 0.15);
    this.waterCavitySynths.forEach(synth => {
      this.linearRamp(synth.volume, this.scaledDb(-18, volumes.waterStream), 0.15);
    });
  }

  private randomCavityFrequency(beta: number) {
    const low = 260;
    const high = 4200 + beta * 1800;
    const skew = Math.pow(Math.random(), 1.75);
    return low * Math.pow(high / low, skew);
  }

  private triggerWaterCavity(now: number, beta: number, theta: number, volume: number) {
    if (this.waterCavitySynths.length === 0 || volume <= 0) return;
    const synth = this.waterCavitySynths[this.waterCavityVoice % this.waterCavitySynths.length];
    this.waterCavityVoice += 1;

    const startFreq = this.randomCavityFrequency(beta);
    const endFreq = startFreq * (1.08 + Math.random() * 0.28);
    const duration = 0.035 + Math.random() * 0.12 + theta * 0.04;
    const startTime = now + Math.random() * 0.08;
    const velocity = (0.015 + beta * 0.055 + theta * 0.025) * volume;

    synth.triggerAttackRelease(startFreq, duration, startTime, velocity);
    this.linearRamp(synth.frequency, endFreq, duration);
  }

  constructor() {
    this.masterVol = new Tone.Volume(-10).toDestination();
    
    // Deep Ocean / Forest Reverb
    this.reverb = new Tone.Reverb({ decay: 5, wet: 0.65 }).connect(this.masterVol);
    // Cave Reverb for drips
    this.caveReverb = new Tone.Reverb({ decay: 3, wet: 0.85 }).connect(this.masterVol);
    this.delay = new Tone.PingPongDelay({ delayTime: "4n", feedback: 0.3, wet: 0.4 }).connect(this.reverb);
    this.dripDelay = new Tone.PingPongDelay({ delayTime: "8n", feedback: 0.18, wet: 0.12 }).connect(this.caveReverb);

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
    }).connect(this.dripDelay);
    this.dripSynth.volume.value = -15;

    // 5. Bird Chirps (Beta occasional)
    this.birdSynth = new Tone.Synth({
      oscillator: { type: "sine" },
      envelope: { attack: 0.02, decay: 0.1, sustain: 0, release: 0.1 }
    }).connect(this.delay);
    this.birdSynth.volume.value = -25;

    // 6. Water-flow grains / edited field-recording texture
    this.hydroCrackleSynth = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.018, sustain: 0, release: 0.018 }
    }).connect(this.caveReverb);
    this.hydroCrackleSynth.volume.value = -28;

    // 7. Small cavity resonators, based on the "many bubbles/cavities" model of running water.
    this.waterCavitySynths = Array.from({ length: 10 }, () => {
      const synth = new Tone.Synth({
        oscillator: { type: "sine" },
        envelope: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.025 }
      }).connect(this.caveReverb);
      synth.volume.value = -18;
      return synth;
    });

    // 8. Wind / Ocean Roar (Brown noise)
    this.windNoise = new Tone.Noise("brown").start();
    this.windFilter = new Tone.Filter(200, "lowpass", -24).connect(this.reverb);
    this.windNoise.connect(this.windFilter);
    this.windNoise.volume.value = -80;

    // 9. Water-flow bed: turbulent support under the resonating cavities.
    this.waterNoise = new Tone.Noise("pink").start();
    this.waterFilter = new Tone.Filter(760, "bandpass", -12).connect(this.reverb);
    this.waterNoise.connect(this.waterFilter);
    this.waterNoise.volume.value = -80;
    
    // Slow irregular movement across the current.
    this.waterLFO = new Tone.LFO({ frequency: 0.7, min: 240, max: 1850 }).start();
    this.waterLFO.connect(this.waterFilter.frequency);
  }

  async start() {
    await Tone.start();
    
    this.setLayerVolumes(this.layerVolumes);
    this.linearRamp(this.windNoise?.volume, this.scaledDb(-60, this.layerVolumes.deepWater), 0.1);
    this.linearRamp(this.waterNoise?.volume, this.scaledDb(-50, this.layerVolumes.waterStream), 0.1);
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
    const agitation = Math.max(0, Math.min(1, b * 0.68 + (1 - a) * 0.22 + t * 0.1));

    // More agitation opens the acoustic space; calm states keep drips close and dry.
    this.linearRamp(this.reverb?.wet, 0.24 + agitation * 0.42, 0.6);
    this.linearRamp(this.caveReverb?.wet, 0.3 + agitation * 0.58, 0.6);
    this.linearRamp(this.dripDelay?.wet, 0.04 + agitation * 0.52, 0.45);
    this.linearRamp(this.dripDelay?.feedback, 0.08 + agitation * 0.54, 0.45);

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

    // Beta -> running water: turbulence bed plus many small resonating cavities.
    this.linearRamp(this.waterNoise.volume, this.scaledDb(-47 + b * 15 + t * 3, volumes.waterStream), 0.3);
    this.linearRamp(this.waterFilter?.frequency, 420 + b * 1200 + t * 360, 0.3);
    this.linearRamp(this.waterFilter?.Q, 0.45 + b * 0.9, 0.3);
    this.linearRamp(this.waterLFO?.frequency, 0.35 + b * 3.2 + t * 0.8, 0.3);

    if (volumes.waterStream > 0) {
      const cavityCount = Math.max(1, Math.floor(1 + b * 4 + t * 2));
      for (let index = 0; index < cavityCount; index += 1) {
        this.triggerWaterCavity(now, b, t, volumes.waterStream);
      }
    }

    if (volumes.waterStream > 0 && now - this.lastCrackleTime > (0.22 - b * 0.12)) {
        const velocity = (0.01 + b * 0.04 + t * 0.018) * volumes.waterStream;
        this.hydroCrackleSynth?.triggerAttackRelease("32n", now, velocity);
        this.lastCrackleTime = now + Math.random() * 0.14;
    }

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
    this.hydroCrackleSynth?.triggerRelease();
    this.waterCavitySynths.forEach(synth => synth.triggerRelease());
    this.linearRamp(this.windNoise?.volume, -80, 1);
    this.linearRamp(this.waterNoise?.volume, -80, 1);
    this.linearRamp(this.masterVol?.volume, -80, 1); // Ensure complete silence
    setTimeout(() => {
        Tone.Transport.stop();
    }, 2000);
  }
}
