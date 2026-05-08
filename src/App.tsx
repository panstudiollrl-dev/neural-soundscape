/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Play, Pause, Wind, Droplets, Leaf, Activity, Sparkles, Settings2, Upload, FileAudio, RotateCcw } from 'lucide-react';
import * as Tone from 'tone';
import Papa from 'papaparse';
import { SoundscapeEngine } from './services/SoundscapeEngine';
import { BrainwaveData, SoundLayerVolumes } from './types';

const ELECTRODE_CHANNELS = ['AF3', 'AF4', 'F7', 'F8', 'T7', 'T8', 'P7', 'P8'] as const;
const REQUIRED_ELECTRODE_COLUMNS = ELECTRODE_CHANNELS.length;
const EMPTY_BRAINWAVE: BrainwaveData = { delta: 0.5, theta: 0.5, alpha: 0.5, beta: 0.5 };
const WAVEFORM_VISUAL_GAIN = 1.7;
const EEG_SAMPLE_RATE_HZ = 128;
const BAND_SMOOTHING_SECONDS = 0.8;
const SEQUENCE_PLAYBACK_HZ = 10;
const DEFAULT_LAYER_VOLUMES: SoundLayerVolumes = {
  deepWater: 1,
  waterStream: 1,
  drone: 1,
  whale: 1,
  drips: 1,
  chimes: 0,
  birds: 1,
};

const SOUND_LAYER_CONTROLS: Array<{ key: keyof SoundLayerVolumes; label: string; description: string }> = [
  { key: 'deepWater', label: 'Deep Water', description: 'Delta ocean body' },
  { key: 'waterStream', label: 'Water Flow', description: 'Field-recorded current' },
  { key: 'drone', label: 'Drone', description: 'Theta pad bed' },
  { key: 'whale', label: 'Whales', description: 'Delta calls' },
  { key: 'drips', label: 'Drips', description: 'Theta droplets' },
  { key: 'chimes', label: 'Chimes', description: 'Alpha sparkle' },
  { key: 'birds', label: 'Birds', description: 'Beta chirps' },
];

type ElectrodeRow = number[];
type BrainwaveBand = keyof BrainwaveData;
type BiquadCoefficients = { b0: number; b1: number; b2: number; a1: number; a2: number };
type BiquadState = { x1: number; x2: number; y1: number; y2: number };

const BRAINWAVE_BANDS: Record<BrainwaveBand, { low: number; high: number; spatialWeights: number[] }> = {
  delta: { low: 0.5, high: 4, spatialWeights: [1, 1, 1, 1, 1, 1, 1, 1] },
  theta: { low: 4, high: 8, spatialWeights: [1.15, 1.15, 1.1, 1.1, 1, 1, 0.9, 0.9] },
  alpha: { low: 8, high: 13, spatialWeights: [0.85, 0.85, 0.95, 0.95, 1.05, 1.05, 1.25, 1.25] },
  beta: { low: 13, high: 30, spatialWeights: [1.2, 1.2, 1.15, 1.15, 1, 1, 0.9, 0.9] },
};

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const percentile = (values: number[], ratio: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(ratio, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

const robustNormalizeLane = (values: number[]) => {
  const center = percentile(values, 0.5);
  const lower = percentile(values, 0.05);
  const upper = percentile(values, 0.95);
  const radius = Math.max(Math.abs(upper - center), Math.abs(center - lower), 0.001);

  return values.map(value => {
    const centered = (value - center) / radius;
    const boosted = 0.5 + centered * 0.42;
    return clamp(boosted, 0.03, 0.97);
  });
};

const commonAverageReference = (rows: ElectrodeRow[]) => rows.map(row => {
  const rowAverage = row.reduce((sum, value) => sum + value, 0) / row.length;
  return row.map(value => value - rowAverage);
});

const createBandpass = (lowHz: number, highHz: number, sampleRateHz: number): BiquadCoefficients => {
  const centerHz = Math.sqrt(lowHz * highHz);
  const bandwidth = Math.max(0.001, highHz - lowHz);
  const q = Math.max(0.2, centerHz / bandwidth);
  const omega = (2 * Math.PI * centerHz) / sampleRateHz;
  const alpha = Math.sin(omega) / (2 * q);
  const cos = Math.cos(omega);
  const a0 = 1 + alpha;

  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
};

const processBiquad = (input: number, coefficients: BiquadCoefficients, state: BiquadState) => {
  const output = coefficients.b0 * input + coefficients.b1 * state.x1 + coefficients.b2 * state.x2 - coefficients.a1 * state.y1 - coefficients.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = input;
  state.y2 = state.y1;
  state.y1 = output;
  return output;
};

const buildBrainwaveSequence = (electrodeRows: ElectrodeRow[]) => {
  const referencedRows = commonAverageReference(electrodeRows);
  const hopSize = Math.max(1, Math.round(EEG_SAMPLE_RATE_HZ / SEQUENCE_PLAYBACK_HZ));
  const smoothing = 1 - Math.exp(-1 / (EEG_SAMPLE_RATE_HZ * BAND_SMOOTHING_SECONDS));
  const bandKeys = Object.keys(BRAINWAVE_BANDS) as BrainwaveBand[];
  const filters = Object.fromEntries(
    bandKeys.map(band => [band, createBandpass(BRAINWAVE_BANDS[band].low, BRAINWAVE_BANDS[band].high, EEG_SAMPLE_RATE_HZ)])
  ) as Record<BrainwaveBand, BiquadCoefficients>;
  const states = Object.fromEntries(
    bandKeys.map(band => [band, Array.from({ length: REQUIRED_ELECTRODE_COLUMNS }, () => ({ x1: 0, x2: 0, y1: 0, y2: 0 }))])
  ) as Record<BrainwaveBand, BiquadState[]>;
  const smoothedPowers = Object.fromEntries(
    bandKeys.map(band => [band, Array(REQUIRED_ELECTRODE_COLUMNS).fill(0)])
  ) as Record<BrainwaveBand, number[]>;
  const rawBandRows: BrainwaveData[] = [];

  referencedRows.forEach((row, rowIndex) => {
    bandKeys.forEach(band => {
      for (let channelIndex = 0; channelIndex < REQUIRED_ELECTRODE_COLUMNS; channelIndex += 1) {
        const filtered = processBiquad(row[channelIndex], filters[band], states[band][channelIndex]);
        smoothedPowers[band][channelIndex] += (filtered * filtered - smoothedPowers[band][channelIndex]) * smoothing;
      }
    });

    if (rowIndex % hopSize === 0) {
      const nextBandPower = {} as BrainwaveData;
      bandKeys.forEach(band => {
      const config = BRAINWAVE_BANDS[band];
      let weightedTotal = 0;
      let weightTotal = 0;

      for (let channelIndex = 0; channelIndex < REQUIRED_ELECTRODE_COLUMNS; channelIndex += 1) {
        const weight = config.spatialWeights[channelIndex] ?? 1;
        weightedTotal += Math.log1p(smoothedPowers[band][channelIndex]) * weight;
        weightTotal += weight;
      }

      nextBandPower[band] = weightedTotal / Math.max(1, weightTotal);
      });

      rawBandRows.push(nextBandPower);
    }
  });

  const rowsToNormalize = rawBandRows.length > 0 ? rawBandRows : [EMPTY_BRAINWAVE];
  const normalized = {
    delta: robustNormalizeLane(rowsToNormalize.map(row => row.delta)),
    theta: robustNormalizeLane(rowsToNormalize.map(row => row.theta)),
    alpha: robustNormalizeLane(rowsToNormalize.map(row => row.alpha)),
    beta: robustNormalizeLane(rowsToNormalize.map(row => row.beta)),
  };

  return rowsToNormalize.map((_, index) => ({
    delta: normalized.delta[index],
    theta: normalized.theta[index],
    alpha: normalized.alpha[index],
    beta: normalized.beta[index],
  }));
};

export default function App() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [eegData, setEegData] = useState<BrainwaveData>({
    delta: 0.5,
    theta: 0.4,
    alpha: 0.3,
    beta: 0.2
  });
  
  // History buffer for the visualizer
  const HISTORY_LENGTH = 100;
  const [history, setHistory] = useState<BrainwaveData[]>(Array(HISTORY_LENGTH).fill(EMPTY_BRAINWAVE));
  
  const [isSimulating, setIsSimulating] = useState(true);
  const [eegSequence, setEegSequence] = useState<BrainwaveData[]>([]);
  const [sequenceIndex, setSequenceIndex] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [layerVolumes, setLayerVolumes] = useState<SoundLayerVolumes>(DEFAULT_LAYER_VOLUMES);

  const engine = useRef<SoundscapeEngine | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    engine.current = new SoundscapeEngine();
    return () => {
      engine.current?.stop();
    };
  }, []);

  useEffect(() => {
    engine.current?.setLayerVolumes(layerVolumes);
  }, [layerVolumes]);

  const updateEegData = (newData: BrainwaveData) => {
    setEegData(newData);
    setHistory(prev => [...prev.slice(1), newData]);
  };

  // EEG Loop (Simulation or Sequence)
  useEffect(() => {
    let interval: NodeJS.Timeout;
    
    if (isPlaying) {
      if (isSimulating) {
        interval = setInterval(() => {
          setEegData(prev => {
            // Smooth random walk between 0 and 1
            const clamp = (val: number) => Math.max(0.1, Math.min(0.9, val));
            const next = {
              delta: clamp(prev.delta + (Math.random() - 0.5) * 0.08),
              theta: clamp(prev.theta + (Math.random() - 0.5) * 0.08),
              alpha: clamp(prev.alpha + (Math.random() - 0.5) * 0.08),
              beta: clamp(prev.beta + (Math.random() - 0.5) * 0.08),
            };
            setHistory(h => [...h.slice(1), next]);
            return next;
          });
        }, 100);
      } else if (eegSequence.length > 0) {
        interval = setInterval(() => {
          setSequenceIndex(prev => {
            const nextIdx = (prev + 1) % eegSequence.length;
            const nextData = eegSequence[nextIdx];
            const normalizedData = {
              delta: clamp(nextData.delta),
              theta: clamp(nextData.theta),
              alpha: clamp(nextData.alpha),
              beta: clamp(nextData.beta)
            };
            setEegData(normalizedData);
            setHistory(h => [...h.slice(1), normalizedData]);
            return nextIdx;
          });
        }, 100); // 10Hz playback for sequence
      }
    }
    
    return () => clearInterval(interval);
  }, [isSimulating, isPlaying, eegSequence]);

  useEffect(() => {
    if (isPlaying && engine.current) {
      try {
        engine.current.updateFromEEG(eegData.delta, eegData.theta, eegData.alpha, eegData.beta);
      } catch (error) {
        console.error('EEG audio update failed', error);
        setPlaybackError('Audio update failed. Visual playback is still available.');
      }
    }
  }, [eegData, isPlaying]);

  const togglePlayback = async () => {
    if (!isPlaying) {
      try {
        setPlaybackError(null);
        await engine.current?.start();
        setIsPlaying(true);
      } catch (error) {
        console.error('Audio engine failed to start', error);
        setPlaybackError('Audio could not start in this browser. Try reloading the page, then press Play again.');
        setIsPlaying(false);
      }
    } else {
      setIsPlaying(false);
      engine.current?.stop();
    }
  };

  const createPath = (data: BrainwaveData[], key: keyof BrainwaveData, width: number, height: number) => {
    if (data.length === 0) return "";
    const step = width / (data.length - 1);
    return data.map((d, i) => {
      const x = i * step;
      let baseline = 0;
      if (key === 'beta') baseline = 18;
      if (key === 'alpha') baseline = 46;
      if (key === 'theta') baseline = 74;
      if (key === 'delta') baseline = 102;
      const val = (d[key] - 0.5) * 42 * WAVEFORM_VISUAL_GAIN;
      const y = baseline - val;
      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
    }).join(" ");
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    
    if (file.name.endsWith('.csv')) {
      Papa.parse(file, {
        worker: true,
        complete: (results) => {
          const rawData = results.data as any[];

          const electrodeRows = rawData
            .filter(row => Array.isArray(row) && row.length >= REQUIRED_ELECTRODE_COLUMNS)
            .map(row => row.slice(0, REQUIRED_ELECTRODE_COLUMNS).map((value: unknown) => Number.parseFloat(String(value))))
            .filter(values => values.every((value: number) => Number.isFinite(value)));

          if (electrodeRows.length === 0) {
            alert(`CSV format error: The first 8 columns must contain numeric ${ELECTRODE_CHANNELS.join(', ')} electrode values.`);
            return;
          }

          const sequence = buildBrainwaveSequence(electrodeRows);

          setEegSequence(sequence);
          setIsSimulating(false);
          setSequenceIndex(0);
          setHistory(Array(HISTORY_LENGTH).fill(EMPTY_BRAINWAVE));
        },
        header: false
      });
    } else if (file.name.endsWith('.edf')) {
      alert(`EDF support requires server-side parsing. Please use CSV where columns 1-8 are ${ELECTRODE_CHANNELS.join(', ')}.`);
    }
  };

  const updateLayerVolume = (key: keyof SoundLayerVolumes, value: number) => {
    setLayerVolumes(prev => ({ ...prev, [key]: clamp(value / 100) }));
  };

  return (
    <div className="min-h-screen bg-[#070909] text-white font-sans selection:bg-orange-500/30 overflow-x-hidden relative">
      {/* Background Atmosphere - Responsive Glowing Blobs based on real EEG data */}
      <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none opacity-40 mix-blend-screen transition-opacity duration-1000" style={{ opacity: isPlaying ? 0.6 : 0.2 }}>
         {/* Delta Blob - Blue/Deep Ocean */}
         <motion.div 
            animate={{ scale: 1 + eegData.delta * 0.5, opacity: 0.2 + eegData.delta * 0.5 }} 
            transition={{ ease: "linear", duration: isSimulating ? 1 : 0.1 }}
            className="absolute -bottom-1/4 -left-1/4 w-[60vw] h-[60vw] bg-blue-700/40 rounded-full blur-[120px]" 
         />
         {/* Theta Blob - Purple/Cave */}
         <motion.div 
            animate={{ scale: 1 + eegData.theta * 0.5, opacity: 0.2 + eegData.theta * 0.5 }} 
            transition={{ ease: "linear", duration: isSimulating ? 1 : 0.1 }}
            className="absolute top-1/4 -left-1/4 w-[50vw] h-[50vw] bg-purple-800/30 rounded-full blur-[120px]" 
         />
         {/* Alpha Blob - Warm/Chimes */}
         <motion.div 
            animate={{ scale: 1 + eegData.alpha * 0.5, opacity: 0.2 + eegData.alpha * 0.5 }} 
            transition={{ ease: "linear", duration: isSimulating ? 1 : 0.1 }}
            className="absolute -top-1/4 right-1/4 w-[40vw] h-[40vw] bg-orange-400/20 rounded-full blur-[100px]" 
         />
         {/* Beta Blob - Emerald/Forest */}
         <motion.div 
            animate={{ scale: 1 + eegData.beta * 0.5, opacity: 0.2 + eegData.beta * 0.5 }} 
            transition={{ ease: "linear", duration: isSimulating ? 1 : 0.1 }}
            className="absolute -bottom-1/4 -right-1/4 w-[50vw] h-[50vw] bg-emerald-500/20 rounded-full blur-[120px]" 
         />
      </div>

      <main className="relative z-10 max-w-7xl mx-auto px-5 py-6 lg:py-8 grid lg:grid-cols-[380px_minmax(0,1fr)] gap-6 items-start min-h-screen">
        
        {/* Left Side: Brand & Control */}
        <div className="space-y-5">
          <header className="space-y-4 rounded-2xl border border-white/10 bg-black/25 p-5 backdrop-blur-xl">
            <motion.div 
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-3"
            >
              <div className="w-10 h-10 rounded-full border border-orange-500/50 flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-orange-400" />
              </div>
              <span className="text-xs font-mono tracking-widest uppercase text-white/40">Mind-State Audio</span>
            </motion.div>
            
            <h1 className="text-4xl font-medium tracking-tight leading-none text-white mix-blend-plus-lighter">
              Neural Soundscape
            </h1>
            
            <p className="text-sm text-white/45 font-light leading-relaxed">
              Transforming synchronized 8-channel EEG into spectral brainwave energy and a living natural environment. 
              Find your center through generated biomes containing whales, birds, water and wind.
            </p>
          </header>

          <div className="rounded-2xl border border-white/10 bg-black/25 p-5 backdrop-blur-xl">
          <div className="flex flex-wrap items-center gap-5">
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={togglePlayback}
              className={`w-20 h-20 rounded-full flex items-center justify-center transition-all duration-500 ${
                isPlaying ? 'bg-orange-500 text-black shadow-[0_0_40px_rgba(249,115,22,0.4)]' : 'bg-white/5 border border-white/10 hover:bg-white/10'
              }`}
            >
              {isPlaying ? <Pause className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 fill-current ml-1" />}
            </motion.button>
            
            <div className="min-w-0 flex-1 space-y-4">
              <div>
                <div className="text-sm font-mono text-white/60 mb-1 uppercase tracking-tighter">Current Source</div>
                <div className="truncate text-xl font-light italic text-white/90">
                  {isSimulating ? 'Generative Simulation' : `Playing: ${fileName}`}
                </div>
                {playbackError && (
                  <div className="mt-2 max-w-sm text-xs font-mono text-orange-300/80">
                    {playbackError}
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="px-4 py-2 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 transition-all text-xs font-mono flex items-center gap-2"
                >
                  <Upload className="w-3 h-3" /> Import EEG CSV
                </button>
                {!isSimulating && (
                  <button 
                    onClick={() => { setIsSimulating(true); setFileName(null); setHistory(Array(HISTORY_LENGTH).fill(EMPTY_BRAINWAVE)); }}
                    className="px-4 py-2 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-400 hover:bg-orange-500/20 transition-all text-xs font-mono flex items-center gap-2"
                  >
                    <RotateCcw className="w-3 h-3" /> Reset
                  </button>
                )}
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  onChange={handleFileUpload} 
                  accept=".csv" 
                  className="hidden" 
                />
              </div>
            </div>
          </div>
          </div>

          <section className="space-y-4 rounded-2xl border border-white/10 bg-black/25 p-5 backdrop-blur-xl">
            <div className="flex items-center gap-3">
              <Settings2 className="w-4 h-4 text-white/50" />
              <div>
                <h2 className="text-xs uppercase tracking-[0.2em] text-white/50 font-semibold">Sound Mix</h2>
              </div>
            </div>
            <div className="grid gap-y-3">
              {SOUND_LAYER_CONTROLS.map(control => (
                <div key={control.key}>
                  <SoundLayerSlider
                    label={control.label}
                    description={control.description}
                    value={layerVolumes[control.key]}
                    onChange={value => updateLayerVolume(control.key, value)}
                  />
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Right Side: Visualization Grid */}
        <div className="grid grid-cols-2 gap-4">
          <StatCard 
            label="Delta" 
            value={Math.round(eegData.delta * 100)} 
            icon={<Wind className="w-4 h-4 text-blue-400" />} 
            description="0.5-4 Hz / Whales"
            active={isPlaying}
            colorClass="bg-blue-500"
          />
          <StatCard 
            label="Theta" 
            value={Math.round(eegData.theta * 100)} 
            icon={<Activity className="w-4 h-4 text-purple-400" />} 
            description="4-8 Hz / Drone"
            active={isPlaying}
            colorClass="bg-purple-500"
          />
          <StatCard 
            label="Alpha" 
            value={Math.round(eegData.alpha * 100)} 
            icon={<Sparkles className="w-4 h-4 text-orange-400" />} 
            description="8-13 Hz / Chimes"
            active={isPlaying}
            colorClass="bg-orange-500"
          />
          <StatCard 
            label="Beta" 
            value={Math.round(eegData.beta * 100)} 
            icon={<Droplets className="w-4 h-4 text-emerald-400" />} 
            description="13-30 Hz / Birds"
            active={isPlaying}
            colorClass="bg-emerald-500"
          />

          {/* Interactive Waveform Section */}
          <div className="col-span-2 mt-2 p-6 rounded-2xl bg-black/30 border border-white/10 backdrop-blur-3xl relative overflow-hidden flex flex-col justify-between">
             <div className="flex justify-between items-start mb-8">
                <div>
                   <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-semibold mb-1">Spectral Flow</h3>
                   <p className="text-sm font-light text-white/60">Whole-head spectral energy mapping at {EEG_SAMPLE_RATE_HZ}Hz</p>
                </div>
                <div className="flex gap-2 items-center text-xs text-white/40 font-mono text-right">
                   <div>β (13-30Hz)</div>
                   <div className="w-2 h-2 rounded-full bg-emerald-400"></div>
                </div>
             </div>
             
             {/* Realistic Continuous Multi-channel EEG Viewer */}
             <div className="h-48 w-full relative z-10 flex flex-col justify-center">
                <svg viewBox="0 0 1000 120" preserveAspectRatio="none" className="w-full h-full absolute inset-0 opacity-90 overflow-visible">
                  <path d={createPath(history, 'beta', 1000, 120)} fill="none" stroke="currentColor" className="text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.8)]" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'd 0.08s linear' }} />
                  <path d={createPath(history, 'alpha', 1000, 120)} fill="none" stroke="currentColor" className="text-orange-400 drop-shadow-[0_0_8px_rgba(251,146,60,0.8)]" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'd 0.08s linear' }} />
                  <path d={createPath(history, 'theta', 1000, 120)} fill="none" stroke="currentColor" className="text-purple-400 drop-shadow-[0_0_8px_rgba(192,132,252,0.8)]" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'd 0.08s linear' }} />
                  <path d={createPath(history, 'delta', 1000, 120)} fill="none" stroke="currentColor" className="text-blue-400 drop-shadow-[0_0_8px_rgba(96,165,250,0.8)]" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'd 0.08s linear' }} />
                </svg>
             </div>

             {/* File Progress Indication */}
             {!isSimulating && eegSequence.length > 0 && (
               <div className="absolute bottom-0 left-0 w-full h-1 bg-white/5">
                 <motion.div 
                   className="h-full bg-orange-500"
                   animate={{ width: `${(sequenceIndex / eegSequence.length) * 100}%` }}
                   transition={{ duration: 0.1, ease: "linear" }}
                 />
               </div>
             )}
          </div>
        </div>
      </main>
    </div>
  );
}

function SoundLayerSlider({ label, description, value, onChange }: { label: string, description: string, value: number, onChange: (value: number) => void }) {
  const percent = Math.round(value * 100);

  return (
    <label className="block rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-widest text-white/70 font-semibold">{label}</span>
        <span className="text-[11px] font-mono text-white/45 tabular-nums">{percent}%</span>
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-tight text-white/30">{description}</div>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={percent}
        onChange={event => onChange(Number(event.target.value))}
        className="mt-2 h-2 w-full accent-orange-400"
      />
    </label>
  );
}

function StatCard({ label, value, icon, description, active, colorClass }: { label: string, value: number, icon: React.ReactNode, description: string, active: boolean, colorClass: string }) {
  return (
    <div className="p-5 rounded-2xl bg-black/30 border border-white/10 hover:border-white/20 transition-all duration-500 backdrop-blur-xl group">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center">
          {icon}
        </div>
        <span className="text-[10px] uppercase tracking-widest text-white/40 font-bold">{label}</span>
      </div>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-3xl font-light tracking-tighter tabular-nums">
          {active ? value : '--'}
        </span>
        <span className="text-sm text-white/20">%</span>
      </div>
      <p className="text-[10px] text-white/30 uppercase tracking-tighter">{description}</p>
      
      <div className="mt-4 h-1 w-full bg-white/5 rounded-full overflow-hidden">
        <motion.div 
          initial={{ width: 0 }}
          animate={{ width: active ? `${value}%` : 0 }}
          transition={{ ease: "linear", duration: 0.1 }}
          className={`h-full ${colorClass}`}
        />
      </div>
    </div>
  );
}
