// The driving plan the overlay coaches against: written by the SimCoach app (see
// writeGuide in app/lib/laps.js), read here. Plain text, so no JSON library is needed.
// C# 5 syntax only, no SimHub types: shared with the test tools.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace SimCoach
{
    public sealed class GuideCorner
    {
        public int Number;
        public string Name = "";
        public double S0, S1;        // start and end of the bend, metres along the track
        public double Plan;          // where to start braking in the target plan (with Lift: where to come off the throttle); < 0: nothing to do
        public double Shift;         // metres that point was moved from where the reference lap braked (+ = later)
        public double MinSpeed;      // km/h to carry at the slowest point
        public double SMin;          // where that slowest point is
        public double Pickup;        // where to be back on the throttle; < 0: none planned
        public int Gear;
        public string Note = "";     // coach's remark for this corner
        public bool Carried;         // braked for together with the corner before: no braking point of its own
        public bool Head;            // its braking runs on into the next corners; MinSpeed is the speed at the end of it
        public bool Lift;            // Plan is where to come off the throttle: no braking, the lift carries the car through
        public bool Flat;            // taken flat out
        public double Pressure;      // brake pedal % to aim for at the hardest point; 0: not given
        public double Release = -1;  // where the brake is fully off again; < 0: not given
        public bool HasBrake { get { return Plan >= 0 && !Lift; } }
        public bool HasLift { get { return Plan >= 0 && Lift; } }
        public string Label { get { return "Z" + Number.ToString(CultureInfo.InvariantCulture) + (Name.Length > 0 ? " " + Name.ToUpperInvariant() : ""); } }
    }

    public sealed class Guide
    {
        public string File = "";
        public string Game = "", Track = "", Config = "", Car = "";
        public double LapTime, Step = 2, Start, Finish;
        public bool Closed;
        public int N;
        public double[] X, Z, T, V;   // track line; reference lap time (s) and speed (km/h) at each point, -1 where unknown
        public List<GuideCorner> Corners = new List<GuideCorner>();
        public double Length { get { return (N - 1) * Step; } }

        private static double Num(string s)
        {
            double v;
            return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v) ? v : 0;
        }

        public static Guide Load(string path)
        {
            string[] lines = System.IO.File.ReadAllLines(path, Encoding.UTF8);
            if (lines.Length < 3 || !lines[0].StartsWith("SIMCOACH-GUIDE", StringComparison.Ordinal)) throw new InvalidDataException("not a SimCoach guide: " + path);
            var g = new Guide();
            g.File = path;
            var head = new Dictionary<string, string>();
            int i = 1;
            for (; i < lines.Length && lines[i] != "[line]"; i++)
            {
                int eq = lines[i].IndexOf('=');
                if (eq > 0) head[lines[i].Substring(0, eq)] = lines[i].Substring(eq + 1).Trim();
            }
            Func<string, string> get = k => head.ContainsKey(k) ? head[k] : "";
            g.Game = get("game"); g.Track = get("track"); g.Config = get("config"); g.Car = get("car");
            g.LapTime = Num(get("lap")); g.Step = Num(get("step")); g.Start = Num(get("start")); g.Finish = Num(get("finish"));
            g.Closed = get("closed") == "1";
            g.N = (int)Num(get("n"));
            if (g.Step <= 0 || g.N < 10 || i + g.N >= lines.Length) throw new InvalidDataException("guide is incomplete: " + path);
            g.X = new double[g.N]; g.Z = new double[g.N]; g.T = new double[g.N]; g.V = new double[g.N];
            i++;
            for (int k = 0; k < g.N; k++, i++)
            {
                string[] p = lines[i].Split(',');
                g.X[k] = Num(p[0]); g.Z[k] = Num(p[1]); g.T[k] = Num(p[2]); g.V[k] = Num(p[3]);
            }
            for (i++; i < lines.Length; i++) // skip the "[corners]" line, then one corner per line
            {
                string[] p = lines[i].Split(';');
                if (p.Length < 11) continue;
                var c = new GuideCorner();
                c.Number = (int)Num(p[0]); c.Name = p[1]; c.S0 = Num(p[2]); c.S1 = Num(p[3]); c.Plan = Num(p[4]); c.Shift = Num(p[5]);
                c.MinSpeed = Num(p[6]); c.SMin = Num(p[7]); c.Pickup = Num(p[8]); c.Gear = (int)Num(p[9]); c.Note = p[10];
                if (p.Length > 11) { c.Carried = p[11].IndexOf('c') >= 0; c.Head = p[11].IndexOf('h') >= 0; c.Lift = p[11].IndexOf('l') >= 0; c.Flat = p[11].IndexOf('f') >= 0; }
                if (p.Length > 13) { c.Pressure = Num(p[12]); c.Release = Num(p[13]); }
                // a lift corner's point comes in a column of its own (older plugins take the braking column at its word)
                if (c.Lift && p.Length > 14 && Num(p[14]) >= 0) c.Plan = Num(p[14]); else c.Lift = false;
                g.Corners.Add(c);
            }
            return g;
        }

        /// <summary>
        /// Nearest point of the track line. <paramref name="hint"/> is the index found for the
        /// previous sample (-1: none): the car only moves forward, so a short window ahead is
        /// searched first, which also keeps neighbouring parts of the track apart.
        /// Returns the index; s is metres along the track, off is the distance from the line.
        /// </summary>
        public int Locate(double x, double z, int hint, out double s, out double off)
        {
            int best = -1;
            double bd = double.MaxValue;
            if (hint >= 0)
            {
                Scan(x, z, Math.Max(0, hint - 10), Math.Min(N - 1, hint + 150), ref best, ref bd);
                if (Closed && hint + 150 > N - 1) Scan(x, z, 0, hint + 150 - (N - 1), ref best, ref bd);
            }
            if (bd > 30.0 * 30.0) { bd = double.MaxValue; Scan(x, z, 0, N - 1, ref best, ref bd); }

            s = best * Step; off = Math.Sqrt(bd);
            double bestD2 = double.MaxValue;
            for (int a = best - 1; a <= best; a++)
            {
                int b = a + 1;
                if (a < 0 || b >= N) continue;
                double ex = X[b] - X[a], ez = Z[b] - Z[a], len2 = ex * ex + ez * ez;
                if (len2 <= 0) continue;
                double u = ((x - X[a]) * ex + (z - Z[a]) * ez) / len2;
                if (u < 0) u = 0; else if (u > 1) u = 1;
                double qx = X[a] + ex * u, qz = Z[a] + ez * u, d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
                if (d2 < bestD2) { bestD2 = d2; s = (a + u) * Step; off = Math.Sqrt(d2); }
            }
            return best;
        }

        private void Scan(double x, double z, int from, int to, ref int best, ref double bd)
        {
            for (int j = from; j <= to; j++)
            {
                double dx = X[j] - x, dz = Z[j] - z, d = dx * dx + dz * dz;
                if (d < bd) { bd = d; best = j; }
            }
        }

        /// <summary>Reference lap's clock at a distance along the track; NaN where that lap has no data.</summary>
        public double TimeAt(double s)
        {
            double f = s / Step;
            int i = (int)Math.Floor(f);
            if (i < 0 || i + 1 >= N || T[i] < 0 || T[i + 1] < 0) return double.NaN;
            return T[i] + (T[i + 1] - T[i]) * (f - i);
        }
    }
}
