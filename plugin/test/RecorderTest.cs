// Synthetic-session test for LapRecorder: out-lap, clean lap, paused + invalidated lap,
// then a teleport to the pits. Runs under the pl-PL culture to catch decimal-comma bugs.
using System;
using System.Globalization;
using System.IO;
using System.Threading;
using SimCoach;

static class RecorderTest
{
    const double Hz = 60.0;
    const int LapFrames = 1200; // 20 s lap

    static int fails;
    static LapRecorder rec;
    static SessionInfo info;
    static double now;
    static int posFrame, tFrame, lap = 1, incIn, lastIn;
    static double lastLap, pendingLapTime;

    static void Check(bool ok, string what)
    {
        Console.WriteLine((ok ? "  ok    " : "  FAIL  ") + what);
        if (!ok) fails++;
    }

    static void Step(bool inPit, bool valid, double speed, bool moving)
    {
        if (posFrame >= LapFrames)
        {
            posFrame = 0;
            pendingLapTime = tFrame / Hz;
            tFrame = 0;
            incIn = 3;   // lap counter lags the line by 3 frames
            lastIn = 10; // last lap time lags by 10 frames
        }
        if (incIn > 0 && --incIn == 0) lap++;
        if (lastIn > 0 && --lastIn == 0) lastLap = pendingLapTime;

        double pos = posFrame / (double)LapFrames;
        var s = new Sample();
        s.T = tFrame / Hz;
        s.Pos = pos;
        s.X = Math.Cos(2 * Math.PI * pos) * 191.0;
        s.Z = Math.Sin(2 * Math.PI * pos) * 191.0;
        s.Speed = speed;
        s.Throttle = 80.5;
        s.Steer = -12.5;
        s.Gear = 4;
        s.Rpm = 6000;
        s.InPit = inPit;
        s.Valid = valid;
        rec.Update(now, s, lap, lastLap, info);

        now += 1.0 / Hz;
        tFrame++;
        if (moving) posFrame++;
    }

    static string Find(string[] files, string marker)
    {
        foreach (string f in files) if (Path.GetFileName(f).Contains(marker)) return f;
        return null;
    }

    static int Main(string[] args)
    {
        Thread.CurrentThread.CurrentCulture = new CultureInfo("pl-PL");
        string dir = args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "simcoach_test");
        if (Directory.Exists(dir)) Directory.Delete(dir, true);

        rec = new LapRecorder(dir, new Logger(Path.Combine(dir, "simcoach.log")));
        rec.SyncWrites = true;
        rec.KeepRunUp = true; // this scenario checks how the out-lap is described; the default (dropping it) is checked at the end
        info = new SessionInfo();
        info.Game = "TestGame";
        info.Track = "Test Track";
        info.TrackConfig = "GP";
        info.Car = "test/car:1";
        info.TrackLength = 1200;

        // Out-lap from the pits, starting at 30% of the lap.
        posFrame = 360;
        for (int i = 0; i < 840; i++) Step(i < 180, true, 216, true);
        // Lap 2: clean.
        for (int i = 0; i < LapFrames; i++) Step(false, true, 216, true);
        // Lap 3: 5 s pause in the middle, invalidated afterwards.
        for (int i = 0; i < LapFrames; i++)
        {
            if (i == 560)
            {
                for (int k = 0; k < 300; k++) rec.Suspend();
                now += 5.0;
            }
            Step(false, i < 660, 216, true);
        }
        // Lap 4: 60% of a lap, then teleport to the pits and sit there.
        for (int i = 0; i < 720; i++) Step(false, true, 216, true);
        posFrame = 24;
        tFrame = 0;
        for (int i = 0; i < 120; i++) Step(true, true, 0, false);
        rec.Shutdown("shutdown");

        string[] csv = Directory.GetFiles(dir, "*.csv", SearchOption.AllDirectories);
        string[] json = Directory.GetFiles(dir, "*.json", SearchOption.AllDirectories);
        Check(rec.LapsSaved == 4, "4 recordings saved (got " + rec.LapsSaved + ")");
        Check(csv.Length == 4 && json.Length == 4, "4 csv + 4 json files");
        string j4 = Find(json, "_lap04_");
        Check(j4 != null && j4.Contains("_partial"), "half lap before the teleport is kept as partial");
        if (j4 != null)
        {
            string t4 = File.ReadAllText(j4);
            Check(t4.Contains("\"ended_by\": \"teleport\"") && t4.Contains("\"coverage\": 0.599"), "partial lap: ended by teleport, ~60% coverage");
            Check(t4.Contains("\"path_m\": 71"), "partial lap: ~720 m driven");
            Check(File.ReadAllLines(Path.ChangeExtension(j4, ".csv")).Length == 721, "partial lap has 720 rows, parked frames not recorded");
        }
        Check(csv.Length > 0 && csv[0].Contains(Path.Combine("laps", "TestGame", "Test Track_GP", "test_car_1")),
            "folder layout game/track/car with sanitized names");

        string j1 = Find(json, "_lap01_"), j2 = Find(json, "_lap02_"), j3 = Find(json, "_lap03_");
        Check(j1 != null && j2 != null && j3 != null, "files named by lap number 01..03");
        if (j1 != null && j2 != null && j3 != null)
        {
            string t1 = File.ReadAllText(j1), t2 = File.ReadAllText(j2), t3 = File.ReadAllText(j3);
            Check(t1.Contains("\"complete\": false") && t1.Contains("\"pit\": true"), "out-lap flagged partial + pit");
            Check(j1.Contains("_partial"), "out-lap file name marked partial");
            Check(t2.Contains("\"lap_time_s\": 20.000") && t2.Contains("\"lap_time_source\": \"game\""), "lap 2 time 20.000 from game");
            Check(t2.Contains("\"complete\": true") && t2.Contains("\"valid\": true") && t2.Contains("\"had_pause\": false"), "lap 2 complete + valid");
            Check(t2.Contains("\"ended_by\": \"line\"") && t2.Contains("\"path_m\": 1199."), "lap 2 ended by line, path ~1200 m");
            Check(t2.Contains("\"sample_rate_hz\": 60.0"), "lap 2 sample rate 60 Hz");
            Check(t3.Contains("\"lap_time_s\": 20.000") && t3.Contains("\"complete\": true"), "lap 3 complete, 20.000 despite pause");
            Check(t3.Contains("\"valid\": false") && t3.Contains("\"had_pause\": true"), "lap 3 invalid + had_pause");
            Check(j3.Contains("_invalid"), "lap 3 file name marked invalid");

            string[] lines = File.ReadAllLines(Path.ChangeExtension(j2, ".csv"));
            Check(lines.Length == LapFrames + 1, "lap 2 csv has header + 1200 rows (got " + lines.Length + ")");
            int cols = lines[0].Split(',').Length;
            bool sameCols = true;
            foreach (string line in lines) if (line.Split(',').Length != cols) sameCols = false;
            Check(cols == LapRecorder.Columns.Length && sameCols, "every row has " + cols + " columns (no decimal commas)");
            string[] first = lines[1].Split(','), last = lines[lines.Length - 1].Split(',');
            double p0 = double.Parse(first[2], CultureInfo.InvariantCulture);
            double p1 = double.Parse(last[2], CultureInfo.InvariantCulture);
            Check(p0 >= 0 && p0 < 0.001 && p1 > 0.99, "lap 2 position runs 0 -> 1 (" + first[2] + " .. " + last[2] + ")");
            Check(first[8] == "80.5" && first[11] == "-12.5" && first[12] == "4", "throttle / steer / gear values round-trip");
            double wallEnd = double.Parse(File.ReadAllLines(Path.ChangeExtension(j3, ".csv"))[LapFrames].Split(',')[0], CultureInfo.InvariantCulture);
            // The frame after a pause adds no wall time (gap length is unknown), so one frame is lost.
            Check(wallEnd > 19.9 && wallEnd < 20.0, "lap 3 wall clock excludes the 5 s pause (" + wallEnd.ToString(CultureInfo.InvariantCulture) + ")");
        }

        // No lap counter (AC Evo): the game is closed mid-lap and frames simply stop arriving.
        posFrame = 0; tFrame = 0; lap = -1; lastLap = 0; incIn = 0; lastIn = 0;
        for (int i = 0; i < 900; i++) Step(false, true, 216, true);
        rec.FlushIfIdle(now + 5, 20);
        Check(rec.LapsSaved == 4, "nothing is flushed after 5 s without frames");
        rec.FlushIfIdle(now + 30, 20);
        Check(rec.LapsSaved == 5, "recording is saved after 30 s without frames");
        string idle = File.ReadAllText(Path.ChangeExtension(rec.LastFile, ".json"));
        Check(idle.Contains("\"ended_by\": \"idle\"") && idle.Contains("\"lap_number\": 1,") && idle.Contains("\"samples\": 900"),
            "idle recording: ended by idle, numbered 1 without a lap counter, 900 samples");

        // By default the drive up to the start line is not kept: only what starts at the line is.
        rec = new LapRecorder(Path.Combine(dir, "default"), new Logger(Path.Combine(dir, "default.log")));
        rec.SyncWrites = true;
        posFrame = 360; tFrame = 0; lap = 1; lastLap = 0; incIn = 0; lastIn = 0;
        for (int i = 0; i < 840; i++) Step(i < 180, true, 216, true);       // from the pits to the line
        for (int i = 0; i < LapFrames; i++) Step(false, true, 216, true);   // a lap
        for (int i = 0; i < 720; i++) Step(false, true, 216, true);         // most of the next one (anything under 12 s is too short to keep)
        rec.Shutdown("shutdown");
        string[] kept = Directory.GetFiles(Path.Combine(dir, "default"), "*.csv", SearchOption.AllDirectories);
        Check(kept.Length == 2, "run-up to the line is not saved: the lap and the unfinished one are (got " + kept.Length + " files)");
        bool anyRunUp = false;
        foreach (string f in kept) if (File.ReadAllText(Path.ChangeExtension(f, ".json")).Contains("\"pit\": true")) anyRunUp = true;
        Check(!anyRunUp, "neither of them is the drive out of the pits");

        Console.WriteLine(fails == 0 ? "ALL PASSED" : fails + " FAILED");
        return fails == 0 ? 0 : 1;
    }
}
