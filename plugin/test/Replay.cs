// Replays recorded lap CSVs (in order) through LapRecorder as if they were live frames.
// Used to check lap splitting against real sessions after changing the recorder.
// Usage: Replay.exe <outputDir> <lap1.csv> [lap2.csv ...]
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using SimCoach;

static class Replay
{
    static int Main(string[] args)
    {
        if (args.Length < 2) { Console.WriteLine("usage: Replay <outputDir> <csv>..."); return 2; }
        string dir = args[0];
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        var rec = new LapRecorder(dir, new Logger(Path.Combine(dir, "simcoach.log")));
        rec.SyncWrites = true;

        var info = new SessionInfo();
        info.Game = "Replay";
        info.Track = "replay";
        info.Car = "replay";
        info.TrackLength = 19300;

        double clock = 0;
        int frames = 0, suspended = 0;
        for (int f = 1; f < args.Length; f++)
        {
            string[] lines = File.ReadAllLines(args[f]);
            string[] head = lines[0].Split(',');
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

                var s = new Sample();
                s.CpFLx = v("cp_fl_x"); s.CpFLy = v("cp_fl_y"); s.CpFLz = v("cp_fl_z");
                s.CpFRx = v("cp_fr_x"); s.CpFRy = v("cp_fr_y"); s.CpFRz = v("cp_fr_z");
                s.CpRLx = v("cp_rl_x"); s.CpRLy = v("cp_rl_y"); s.CpRLz = v("cp_rl_z");
                s.CpRRx = v("cp_rr_x"); s.CpRRy = v("cp_rr_y"); s.CpRRz = v("cp_rr_z");
                if (s.CpFLx == 0 && s.CpFLz == 0 && s.CpRRx == 0 && s.CpRRz == 0)
                {
                    rec.Suspend();
                    suspended++;
                    continue;
                }
                s.X = (s.CpFLx + s.CpFRx + s.CpRLx + s.CpRRx) / 4;
                s.Y = (s.CpFLy + s.CpFRy + s.CpRLy + s.CpRRy) / 4;
                s.Z = (s.CpFLz + s.CpFRz + s.CpRLz + s.CpRRz) / 4;
                s.T = v("t");
                double pos = v("pos");
                s.Pos = pos - Math.Floor(pos);
                if (pos == 1.0) s.Pos = 1.0;
                s.Speed = v("speed"); s.Throttle = v("throttle"); s.Brake = v("brake"); s.Clutch = v("clutch");
                s.Steer = v("steer"); s.Gear = (int)v("gear"); s.Rpm = v("rpm");
                s.GLat = v("glat"); s.GLon = v("glon"); s.Yaw = v("yaw");
                s.Abs = (int)v("abs"); s.Tc = (int)v("tc"); s.TyresOut = (int)v("tyres_out");
                s.SaFL = v("sa_fl"); s.SaFR = v("sa_fr"); s.SaRL = v("sa_rl"); s.SaRR = v("sa_rr");
                s.WsFL = v("ws_fl"); s.WsFR = v("ws_fr"); s.WsRL = v("ws_rl"); s.WsRR = v("ws_rr");
                s.InPit = v("in_pit") != 0; s.Valid = v("valid") != 0;
                s.Kerb = v("kerb"); s.Heading = v("heading");
                rec.Update(clock, s, 1, 0, info);
                frames++;
            }
            clock += 1.0 / 60.0;
        }
        rec.Shutdown("shutdown");
        Console.WriteLine("frames " + frames + ", suspended " + suspended + ", recordings " + rec.LapsSaved);
        Console.WriteLine(File.ReadAllText(Path.Combine(dir, "simcoach.log")));
        return 0;
    }
}
