// Replays recorded laps through the coach engine as if they were driven live and prints
// what the overlay would have said. Usage: CoachTest.exe <guide.txt> <lap.csv> [more.csv ...]
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using SimCoach;

static class CoachTest
{
    static int Main(string[] args)
    {
        if (args.Length < 2) { Console.WriteLine("usage: CoachTest <guide> <csv>..."); return 2; }
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Guide g = Guide.Load(args[0]);
        var engine = new CoachEngine(g);
        Console.WriteLine("guide: " + g.Track + " " + g.Config + " | " + g.Car + " | " + g.N + " points, " + g.Corners.Count + " corners, reference lap " + g.LapTime.ToString("0.000", CultureInfo.InvariantCulture) + " s");

        double clock = 0, lastDelta = double.NaN;
        string lastMessage = "";
        int verdicts = 0, better = 0, worse = 0, countdowns = 0, flashes = 0, frames = 0;
        bool inCountdown = false, inFlash = false, inGas = false, inGasPhase = false;
        int gasFlashes = 0, gasPhases = 0, limit = 12;
        var sounds = new int[5];
        int onLap = 0, offLap = 0, mutedSounds = 0;
        // how long each braking or lift point was counted down to before the car reached it
        var lead = new Dictionary<string, double>(); string counting = ""; double countFrom = 0;
        foreach (string a in args) if (a == "--all") limit = 1000;
        var firstCountdowns = new List<string>();
        for (int f = 1; f < args.Length; f++)
        {
            if (args[f] == "--all") continue;
            string[] lines = File.ReadAllLines(args[f]);
            string[] head = lines[0].Trim().Split(',');
            var ix = new Dictionary<string, int>();
            for (int i = 0; i < head.Length; i++) ix[head[i]] = i;
            double prevWall = 0;
            for (int r = 1; r < lines.Length; r++)
            {
                string[] c = lines[r].Split(',');
                Func<string, double> v = name => double.Parse(c[ix[name]], CultureInfo.InvariantCulture);
                double wall = v("wall");
                clock += Math.Max(0, wall - prevWall);
                prevWall = wall;
                double x = v("x"), z = v("z");
                if (x == 0 && z == 0)
                {
                    x = (v("cp_fl_x") + v("cp_fr_x") + v("cp_rl_x") + v("cp_rr_x")) / 4;
                    z = (v("cp_fl_z") + v("cp_fr_z") + v("cp_rl_z") + v("cp_rr_z")) / 4;
                    if (x == 0 && z == 0) continue;
                }
                CoachState st = engine.Update(clock, x, z, v("speed"), v("brake"), v("throttle"));
                if (st.OnLap) onLap++; else { offLap++; if (st.Sound > 0) mutedSounds++; }
                if (st.Sound > 0 && st.OnLap) sounds[st.Sound]++;
                if ((st.Phase == 1 || st.Phase == 4) && st.Corner != counting) { counting = st.Corner; countFrom = clock; }
                if (counting.Length > 0 && (st.Corner != counting || (st.Phase != 1 && st.Phase != 4))) { lead[counting] = clock - countFrom; counting = ""; }
                if (st.GasNow && !inGas) gasFlashes++;
                inGas = st.GasNow;
                if (st.Phase == 2 && !inGasPhase) gasPhases++;
                inGasPhase = st.Phase == 2;
                frames++;
                if (!st.Active) continue;
                if (!double.IsNaN(st.Delta)) lastDelta = st.Delta;
                if (st.Countdown && !inCountdown) { countdowns++; if (firstCountdowns.Count < 4) firstCountdowns.Add(st.Corner + " from " + st.ToCorner.ToString("0", CultureInfo.InvariantCulture) + " m at " + st.Speed.ToString("0", CultureInfo.InvariantCulture) + " km/h"); }
                inCountdown = st.Countdown;
                if (st.BrakeNow && !inFlash) flashes++;
                inFlash = st.BrakeNow;
                if (st.Message != lastMessage)
                {
                    lastMessage = st.Message;
                    if (st.Message.Length > 0 && st.MessageKind != 1)
                    {
                        verdicts++;
                        if (st.MessageKind == 2) better++; else if (st.MessageKind == 3) worse++;
                        if (verdicts <= limit || st.Message.StartsWith("Okr")) Console.WriteLine("  " + (st.S / 1000).ToString("00.00", CultureInfo.InvariantCulture) + " km  [" + st.MessageKind + "] " + st.Message);
                    }
                    else if (st.MessageKind == 1) Console.WriteLine("  " + (st.S / 1000).ToString("00.00", CultureInfo.InvariantCulture) + " km  [coach] " + st.Message);
                }
            }
            clock += 1.0 / 60.0;
        }
        Console.WriteLine("frames " + frames + " | countdowns " + countdowns + " | 'brake now' flashes " + flashes + " | verdicts " + verdicts + " (as planned or better " + better + ", worse " + worse + ") | throttle countdowns " + gasPhases + ", 'throttle now' flashes " + gasFlashes);
        Console.WriteLine("sounds: ticks " + sounds[1] + ", braking points " + sounds[2] + ", throttle points " + sounds[3] + ", lift points " + sounds[4]);
        var brief = new List<string>(); int pointsShown = 0;
        foreach (var kv in lead) { pointsShown++; if (kv.Value < 1.5) brief.Add(kv.Key.Split(' ')[0] + " " + kv.Value.ToString("0.0", CultureInfo.InvariantCulture) + " s"); }
        Console.WriteLine("points counted down to: " + pointsShown + " | shown for under 1.5 s: " + brief.Count + (brief.Count > 0 ? " (" + string.Join(", ", brief.ToArray()) + ")" : ""));
        Console.WriteLine("on a timed lap: " + onLap + " frames, outside it: " + offLap + " frames (overlay hidden, " + mutedSounds + " sounds not played)");
        Console.WriteLine("first countdowns: " + string.Join("; ", firstCountdowns));
        Console.WriteLine("last live delta: " + (double.IsNaN(lastDelta) ? "none" : lastDelta.ToString("0.000", CultureInfo.InvariantCulture)));
        return 0;
    }
}
