// The coach's sounds, made here rather than shipped as files. Four of them (a tick counting
// down to a braking point, the braking point, the throttle point, the point to lift at) in a
// few sets to choose from, or the driver's own WAV files. C# 5 syntax, no SimHub types.
using System;
using System.Collections.Generic;
using System.IO;
using System.Media;

namespace SimCoach
{
    /// <summary>One layer of a sound: a tone or a burst of noise that starts, glides and dies away.</summary>
    internal sealed class Voice
    {
        public double At, Length, From, To;   // seconds; pitch in Hz at its start and end
        public double Level = 1.0;
        public double Decay;                  // seconds for it to die to about a third; 0: held level (a beep)
        public int Wave;                      // 0 sine, 1 soft square (a beep's body), 2 bell (a plucked, glassy tone), 3 noise
        public Voice(double at, double length, double from, double to, double level, double decay, int wave)
        {
            At = at; Length = length; From = from; To = to; Level = level; Decay = decay; Wave = wave;
        }
    }

    internal sealed class SoundBank : IDisposable
    {
        public const int Kinds = 4;           // 1 tick, 2 braking point, 3 throttle point, 4 lift point
        public static readonly string[] Themes = { "soft", "race", "neon", "pulse", "own" };
        private const int Rate = 44100;
        private readonly SoundPlayer[] players = new SoundPlayer[Kinds + 1];
        private readonly MemoryStream[] streams = new MemoryStream[Kinds + 1];
        private readonly double[][] stats = new double[Kinds + 1][];
        public readonly double Volume;
        public readonly int Theme;

        /// <param name="volume">0..1</param>
        /// <param name="theme">index into Themes; "own" plays tick.wav, brake.wav, gas.wav and lift.wav from soundsDir</param>
        public SoundBank(double volume, int theme, string soundsDir)
        {
            Volume = volume; Theme = Math.Max(0, Math.Min(Themes.Length - 1, theme));
            string[] files = { "", "tick.wav", "brake.wav", "gas.wav", "lift.wav" };
            // how loud each kind is against the loudest (the braking point): the tick is only a hint of what is coming
            double[] share = { 0, 0.7, 1.0, 0.9, 0.8 };
            for (int kind = 1; kind <= Kinds; kind++)
            {
                if (Themes[Theme] == "own" && soundsDir != null)
                {
                    string file = Path.Combine(soundsDir, files[kind]);
                    if (File.Exists(file))
                    {
                        try { var p = new SoundPlayer(file); p.Load(); players[kind] = p; stats[kind] = new[] { 0.0, 0.0, 0.0 }; continue; }
                        catch { /* not a WAV the system can play: the built-in one instead */ }
                    }
                }
                double echo;
                List<Voice> voices = Compose(Themes[Theme] == "own" ? "soft" : Themes[Theme], kind, out echo);
                Store(kind, Render(voices, echo, 0.95 * share[kind] * volume));
            }
        }

        // The sets. Every one keeps the same idea, so they can be learnt once: the braking point is
        // the longest and lowest or falling, the throttle point is bright and rising, the lift is
        // a single middle note, the tick is the shortest.
        private static List<Voice> Compose(string theme, int kind, out double echo)
        {
            var v = new List<Voice>();
            echo = 0;
            if (theme == "race")
            {
                // electronic beeps like start lights and shift tones: high, hard-edged, easy to hear over an engine
                if (kind == 1) v.Add(new Voice(0, 0.045, 1568, 1568, 1, 0, 1));
                else if (kind == 2) v.Add(new Voice(0, 0.240, 2093, 2093, 1, 0, 1));
                else if (kind == 3) { v.Add(new Voice(0, 0.055, 2637, 2637, 1, 0, 1)); v.Add(new Voice(0.095, 0.055, 2637, 2637, 1, 0, 1)); }
                else v.Add(new Voice(0, 0.090, 1175, 1175, 1, 0, 1));
            }
            else if (theme == "neon")
            {
                // glassy plucked notes with a short echo, like a modern interface: two notes down to brake, three up for the throttle
                echo = kind == 1 ? 0 : 0.26;
                if (kind == 1) v.Add(new Voice(0, 0.070, 1319, 1319, 1, 0.022, 2));
                else if (kind == 2) { v.Add(new Voice(0, 0.200, 1760, 1760, 1, 0.060, 2)); v.Add(new Voice(0.090, 0.260, 1175, 1175, 1, 0.085, 2)); }
                else if (kind == 3) { v.Add(new Voice(0, 0.120, 1175, 1175, 0.8, 0.040, 2)); v.Add(new Voice(0.070, 0.120, 1760, 1760, 0.9, 0.040, 2)); v.Add(new Voice(0.140, 0.200, 2349, 2349, 1, 0.060, 2)); }
                else v.Add(new Voice(0, 0.200, 1568, 1480, 1, 0.060, 2));
            }
            else if (theme == "pulse")
            {
                // drum-like: a click for the tick, a thump with a hard edge to brake, a rising zap for the throttle, a snap to lift
                if (kind == 1) { v.Add(new Voice(0, 0.030, 7000, 7000, 1, 0.008, 3)); v.Add(new Voice(0, 0.020, 3200, 3200, 0.5, 0.006, 0)); }
                else if (kind == 2)
                {
                    v.Add(new Voice(0, 0.220, 170, 52, 1, 0.075, 0));      // the thump
                    v.Add(new Voice(0, 0.110, 880, 660, 0.45, 0.040, 1));  // a body that small speakers and a loud engine leave audible
                    v.Add(new Voice(0, 0.014, 2400, 2400, 0.6, 0.005, 0)); // the edge
                }
                else if (kind == 3) { v.Add(new Voice(0, 0.100, 520, 2700, 1, 0.045, 1)); v.Add(new Voice(0, 0.100, 1040, 5400, 0.25, 0.030, 0)); }
                else { v.Add(new Voice(0, 0.035, 2600, 2600, 1, 0.010, 3)); v.Add(new Voice(0, 0.060, 1245, 1100, 0.7, 0.020, 0)); }
            }
            else
            {
                // soft: round sine notes
                if (kind == 1) v.Add(new Voice(0, 0.060, 880, 880, 1, 0.018, 0));
                else if (kind == 2) v.Add(new Voice(0, 0.240, 587, 587, 1, 0.080, 0));
                else if (kind == 3) v.Add(new Voice(0, 0.140, 988, 1319, 1, 0.050, 0));
                else v.Add(new Voice(0, 0.120, 784, 659, 1, 0.045, 0));
            }
            return v;
        }

        // Adds the voices up, lets an echo ring once or twice, presses the result gently against
        // its ceiling (louder to the ear at the same peak) and scales it to the peak asked for.
        private static double[] Render(List<Voice> voices, double echo, double peak)
        {
            const double echoDelay = 0.105;
            double total = 0;
            foreach (Voice v in voices) total = Math.Max(total, v.At + v.Length);
            if (echo > 0) total += 2 * echoDelay + 0.05;
            int n = (int)(total * Rate) + 1;
            var mix = new double[n];
            var noise = new Random(7);
            foreach (Voice v in voices)
            {
                int start = (int)(v.At * Rate), len = (int)(v.Length * Rate);
                double phase = 0, low = 0, prev = 0;
                for (int i = 0; i < len && start + i < n; i++)
                {
                    double t = (double)i / Rate, f = v.From + (v.To - v.From) * i / Math.Max(1, len);
                    phase += 2 * Math.PI * f / Rate;
                    double x;
                    if (v.Wave == 1) x = Math.Tanh(2.2 * Math.Sin(phase)) * 0.9;                                    // rounded square
                    else if (v.Wave == 2) x = Math.Sin(phase + 1.6 * Math.Exp(-t / 0.035) * Math.Sin(3.5 * phase))   // a struck, glassy start
                                             + 0.35 * Math.Sin(2.003 * phase) * Math.Exp(-t / (v.Decay * 0.6 + 0.001));
                    else if (v.Wave == 3)
                    {
                        // hiss, kept to the band around the pitch given: above it rolled off, below it removed
                        double white = noise.NextDouble() * 2 - 1, k = Math.Min(0.99, 2 * Math.PI * f / Rate);
                        low += k * (white - low);
                        x = (low - prev) * 4; prev = low;
                    }
                    else x = Math.Sin(phase) + 0.15 * Math.Sin(2 * phase);
                    double envelope = Math.Min(1.0, t / 0.003) * Math.Min(1.0, (v.Length - t) / 0.008) * (v.Decay > 0 ? Math.Exp(-t / v.Decay) : 1.0);
                    mix[start + i] += v.Level * envelope * x;
                }
            }
            if (echo > 0)
            {
                int d = (int)(echoDelay * Rate);
                for (int i = d; i < n; i++) mix[i] += echo * mix[i - d];
            }
            double max = 1e-9;
            for (int i = 0; i < n; i++) max = Math.Max(max, Math.Abs(mix[i]));
            const double drive = 1.6;
            for (int i = 0; i < n; i++) mix[i] = Math.Tanh(drive * mix[i] / max) / Math.Tanh(drive) * peak;
            return mix;
        }

        private void Store(int kind, double[] samples)
        {
            int n = samples.Length;
            var ms = new MemoryStream();
            var w = new BinaryWriter(ms);
            w.Write(new[] { 'R', 'I', 'F', 'F' }); w.Write(36 + n * 2); w.Write(new[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' });
            w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(Rate); w.Write(Rate * 2); w.Write((short)2); w.Write((short)16);
            w.Write(new[] { 'd', 'a', 't', 'a' }); w.Write(n * 2);
            double peak = 0, power = 0;
            for (int i = 0; i < n; i++)
            {
                double s = Math.Max(-1.0, Math.Min(1.0, samples[i]));
                w.Write((short)(s * 32767));
                peak = Math.Max(peak, Math.Abs(s)); power += s * s;
            }
            w.Flush();
            ms.Position = 0;
            streams[kind] = ms;
            players[kind] = new SoundPlayer(ms);
            players[kind].Load();
            stats[kind] = new[] { (double)n / Rate, peak, Math.Sqrt(power / Math.Max(1, n)) };
        }

        /// <summary>Length in seconds, loudest sample and average level (both 0..1) of a sound; zeros for a file of the driver's own.</summary>
        public double[] Describe(int kind) { return stats[kind]; }

        public void Play(int kind)
        {
            if (kind > 0 && kind < players.Length && players[kind] != null) players[kind].Play();
        }

        public void Dispose()
        {
            for (int i = 0; i < players.Length; i++) { if (players[i] != null) players[i].Dispose(); if (streams[i] != null) streams[i].Dispose(); }
        }
    }
}
