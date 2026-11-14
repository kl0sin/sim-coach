// Game-independent lap recorder: buffers telemetry samples, splits them into laps
// and writes one CSV + one JSON sidecar per lap. No SimHub types here so it can be
// tested without the game. Kept to C# 5 syntax (built with the csc.exe shipped in Windows).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

namespace SimCoach
{
    public struct Sample
    {
        public double Wall;      // seconds since lap buffer start, pauses excluded
        public double T;         // game lap time, seconds
        public double Pos;       // lap fraction 0..1
        public double X, Y, Z;   // world coordinates, metres (Y is up)
        public double Speed;     // km/h
        public double Throttle, Brake, Clutch; // 0..100
        public double Steer;     // steering wheel angle, degrees
        public double Rpm;
        public double GLat, GLon;
        public double Yaw;
        public double SaFL, SaFR, SaRL, SaRR; // tyre slip angles
        public double WsFL, WsFR, WsRL, WsRR; // wheel slip
        public double Kerb;      // kerb vibration signal
        public double Heading;   // car heading from the game physics, radians
        // Tyre contact points in world coordinates (FL, FR, RL, RR), used to map track edges.
        public double CpFLx, CpFLy, CpFLz, CpFRx, CpFRy, CpFRz;
        public double CpRLx, CpRLy, CpRLz, CpRRx, CpRRy, CpRRz;
        public int Gear;         // -1 = R, 0 = N
        public int Abs, Tc;      // intervention active
        public int TyresOut;     // tyres outside track limits
        public bool InPit;
        public bool Valid;       // game's "lap still valid" flag
        public double Ahead, Behind; // metres along the track to the nearest other car in front / behind; 0 or less: none, or not known
        public double Fuel;      // in the game's unit (litres)
        public double TyreTemp;  // mean of the four tyres, degrees C
    }

    public class SessionInfo
    {
        public string Game = "";
        public string Track = "";
        public string TrackConfig = "";
        public string Car = "";
        public string SessionType = "";
        public string SessionId = "";
        public string SmVersion = "";
        public string GameVersion = "";
        public double TrackLength;
        /// <summary>Last lap time read straight from the game, seconds; negative when not available.</summary>
        public double RawLastLap = -1;

        public string Key() { return Game + "|" + Track + "|" + TrackConfig + "|" + Car; }
        public SessionInfo Clone() { return (SessionInfo)MemberwiseClone(); }
    }

    public class Logger
    {
        private readonly string path;
        private readonly object gate = new object();

        public Logger(string path) { this.path = path; }

        public void Write(string message)
        {
            try
            {
                lock (gate)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(path));
                    File.AppendAllText(path,
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "  " + message + Environment.NewLine);
                }
            }
            catch { /* logging must never break the data loop */ }
        }
    }

    public class LapRecorder
    {
        public const double MinLapSeconds = 10.0;
        private const int FinalizeDelayFrames = 30;
        private const int MaxSamples = 400000;
        private const double TeleportMetres = 50.0;

        public static readonly string[] Columns = {
            "wall", "t", "pos", "dist", "x", "y", "z", "speed", "throttle", "brake", "clutch", "steer",
            "gear", "rpm", "glat", "glon", "yaw", "abs", "tc", "tyres_out",
            "sa_fl", "sa_fr", "sa_rl", "sa_rr", "ws_fl", "ws_fr", "ws_rl", "ws_rr", "in_pit", "valid",
            "kerb", "heading",
            "cp_fl_x", "cp_fl_y", "cp_fl_z", "cp_fr_x", "cp_fr_y", "cp_fr_z",
            "cp_rl_x", "cp_rl_y", "cp_rl_z", "cp_rr_x", "cp_rr_y", "cp_rr_z",
            // (new columns only ever go at the end: the app finds them by name, older recordings simply lack them)
            "ahead_m", "behind_m", "fuel", "tyre_c"
        };

        private sealed class PendingLap
        {
            public List<Sample> Samples;
            public SessionInfo Info;
            public int Lap;
            public DateTime Started;
            public bool HadPause;
            public bool StartedAtLine;
            public string EndedBy;
            public double LapTimeRef;
            public int Frames;
        }

        private readonly string dataDir;
        private readonly Logger log;
        private readonly object gate = new object();

        /// <summary>Write files on the calling thread (tests). Default: thread pool.</summary>
        public bool SyncWrites;
        /// <summary>Also save the drive up to the start line (out of the pits, or from the car park
        /// on the Nordschleife tourist layout). Off: it is no lap and nobody looks at it.</summary>
        public bool KeepRunUp;

        private List<Sample> buf = new List<Sample>(8192);
        private SessionInfo bufInfo;
        private string bufKey;
        private int bufLap;
        private DateTime bufStarted;
        private bool bufHadPause;
        private bool bufStartedAtLine;
        private double bufLapTimeRef;
        private double wall;

        private bool havePrev;
        private Sample prev;
        private int prevLap;
        private double lastNow;
        private bool suspended;
        private int suspendedFrames;
        private double lastSeenLapTime;
        private int sequence;

        private PendingLap pending;
        private int lapsSaved;
        private volatile string lastFile = "";

        public LapRecorder(string dataDir, Logger log)
        {
            this.dataDir = dataDir;
            this.log = log;
        }

        public int LapsSaved { get { return lapsSaved; } }
        public string LastFile { get { return lastFile; } }
        public int BufferedSamples { get { return buf.Count; } }

        /// <summary>Feed one live frame. <paramref name="now"/> is a monotonic clock in seconds.</summary>
        public void Update(double now, Sample s, int lapNumber, double lastLapTime, SessionInfo info)
        {
            lock (gate) { UpdateCore(now, s, lapNumber, lastLapTime, info); }
        }

        private void UpdateCore(double now, Sample s, int lapNumber, double lastLapTime, SessionInfo info)
        {
            lastSeenLapTime = lastLapTime;
            string key = info.Key();
            if (bufKey != null && bufKey != key) EndBuffer("session changed");
            if (pending != null)
            {
                pending.Frames--;
                if (pending.Frames <= 0) FlushPending(lastLapTime);
            }

            double dt = 0;
            if (havePrev && !suspended)
            {
                dt = now - lastNow;
                if (dt < 0 || dt > 1.0) dt = 0;
            }
            bool resumed = suspended && havePrev;
            suspended = false;
            suspendedFrames = 0;
            lastNow = now;

            bool startAtLine = false;
            if (havePrev)
            {
                bool wrap = prev.Pos > 0.9 && s.Pos < 0.1;
                bool reverseWrap = prev.Pos < 0.1 && s.Pos > 0.9;
                // A negative lap number means "do not trust the lap counter": in AC Evo
                // multiplayer it changes at arbitrary places and even goes backwards.
                bool counter = lapNumber >= 0 && prevLap >= 0;
                bool lapInc = counter && lapNumber > prevLap;
                bool timeReset = s.T + 5.0 < prev.T;
                // Lap counter, lap timer and track position do not change on the same frame,
                // and on some layouts the timing line is not at position 0, so any of the
                // three signals counts as a lap boundary.
                bool boundary = lapInc || timeReset || (wrap && prev.T <= 0.0);

                if (HasXZ(prev) && HasXZ(s) && Distance(prev, s) > TeleportMetres)
                {
                    EndBuffer("teleport");
                }
                else if (counter && lapNumber < prevLap)
                {
                    EndBuffer("lap counter went back");
                }
                else if (!wrap && !reverseWrap && Math.Abs(s.Pos - prev.Pos) > 0.05)
                {
                    EndBuffer("position jump");
                }
                else if (boundary)
                {
                    if (bufStartedAtLine && wall < 2.0)
                    {
                        // Second signal for the boundary we already handled.
                        if (lapInc) bufLap = lapNumber;
                    }
                    else if (wall < MinLapSeconds)
                    {
                        Discard();
                        startAtLine = true;
                    }
                    else if (s.Speed < 5.0)
                    {
                        EndBuffer("timing reset at standstill");
                    }
                    else
                    {
                        CloseLap();
                        startAtLine = true;
                    }
                }
            }

            if (buf.Count >= MaxSamples) EndBuffer("buffer limit");

            if (buf.Count == 0)
            {
                if (s.Speed < 2.0 && !startAtLine)
                {
                    // Parked: do not start a recording yet.
                    havePrev = false;
                    return;
                }
                bufInfo = info.Clone();
                bufKey = key;
                // Without a trustworthy lap counter, number the recordings in the order they were made.
                bufLap = lapNumber >= 0 ? lapNumber : ++sequence;
                bufStarted = DateTime.Now;
                bufHadPause = false;
                bufStartedAtLine = startAtLine;
                bufLapTimeRef = -1;
                wall = 0;
            }
            else
            {
                wall += dt;
                if (resumed) bufHadPause = true;
            }
            // The game's "last lap time" a few seconds into the lap still belongs to the
            // previous lap; a different value at the end means it is this lap's time.
            if (bufLapTimeRef < 0 && wall >= 5.0) bufLapTimeRef = lastLapTime;

            s.Wall = wall;
            buf.Add(s);
            prev = s;
            prevLap = lapNumber;
            havePrev = true;
        }

        /// <summary>Call for frames that must not be recorded (pause, menu, replay, garage).</summary>
        public void Suspend()
        {
            lock (gate)
            {
                if (havePrev) suspended = true;
                if (pending != null && ++suspendedFrames > 120) FlushPending(lastSeenLapTime);
            }
        }

        /// <summary>
        /// Saves the recording in progress when no live frame has arrived for a while (the
        /// game was closed or left the track without any event the recorder could see).
        /// Call periodically from a timer; <paramref name="now"/> is the same clock as Update.
        /// </summary>
        public void FlushIfIdle(double now, double idleSeconds)
        {
            lock (gate)
            {
                if (now - lastNow < idleSeconds) return;
                if (buf.Count > 0) EndBuffer("idle");
                else if (pending != null) FlushPending(lastSeenLapTime);
            }
        }

        /// <summary>
        /// Saves whatever is buffered, synchronously. Safe to call from any thread and more
        /// than once (plugin end, process exit, Windows session ending).
        /// </summary>
        public void Shutdown(string reason)
        {
            lock (gate)
            {
                SyncWrites = true;
                EndBuffer(reason);
            }
        }

        private static bool HasXZ(Sample s) { return s.X != 0.0 || s.Z != 0.0; }

        private static double Distance(Sample a, Sample b)
        {
            double dx = a.X - b.X, dy = a.Y - b.Y, dz = a.Z - b.Z;
            return Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }

        private PendingLap TakeBuffer(string endedBy)
        {
            var p = new PendingLap
            {
                Samples = buf,
                Info = bufInfo,
                Lap = bufLap,
                Started = bufStarted,
                HadPause = bufHadPause,
                StartedAtLine = bufStartedAtLine,
                EndedBy = endedBy,
                LapTimeRef = bufLapTimeRef,
                Frames = FinalizeDelayFrames
            };
            buf = new List<Sample>(8192);
            return p;
        }

        private void Discard()
        {
            buf.Clear();
            bufKey = null;
            havePrev = false;
            wall = 0;
        }

        /// <summary>The lap ended at the timing line: write it once the game has published the lap time.</summary>
        private void CloseLap()
        {
            FlushPending(lastSeenLapTime);
            pending = TakeBuffer("line");
        }

        /// <summary>The recording was cut short (teleport, quit, session change): keep what we have.</summary>
        private void EndBuffer(string reason)
        {
            FlushPending(lastSeenLapTime);
            if (buf.Count > 0)
            {
                pending = TakeBuffer(reason);
                FlushPending(lastSeenLapTime);
            }
            Discard();
        }

        private void FlushPending(double gameLapTime)
        {
            PendingLap p = pending;
            pending = null;
            if (p == null) return;
            if (SyncWrites) WriteLap(p, gameLapTime);
            else ThreadPool.QueueUserWorkItem(delegate { WriteLap(p, gameLapTime); });
        }

        private void WriteLap(PendingLap p, double gameLapTime)
        {
            try
            {
                List<Sample> a = p.Samples;
                int n = a.Count;
                if (n < 2) return;
                double endWall = a[n - 1].Wall;
                SessionInfo info = p.Info;

                // One pass: unwrap the lap position so it is monotonic (it may start slightly
                // below 0 and end above 1), measure distance driven and lap coverage.
                double[] dist = new double[n];
                double rawPrev = a[0].Pos;
                double unwrapped = rawPrev;
                if (p.StartedAtLine && unwrapped > 0.9) unwrapped -= 1.0;
                double startPos = unwrapped;
                double coverage = 0, path = 0, maxSpeed = 0, invalidAt = -1, tAtInvalid = 0;
                bool pit = false;
                int offTrack = 0;
                for (int i = 0; i < n; i++)
                {
                    Sample s = a[i];
                    if (i > 0)
                    {
                        double d = s.Pos - rawPrev;
                        rawPrev = s.Pos;
                        if (d > 0.5) d -= 1.0; else if (d < -0.5) d += 1.0;
                        unwrapped += d;
                        if (d > 0 && d < 0.05) coverage += d;
                        if (HasXZ(a[i - 1]) && HasXZ(s))
                        {
                            double step = Distance(a[i - 1], s);
                            if (step < TeleportMetres) path += step;
                        }
                    }
                    dist[i] = path;
                    s.Pos = unwrapped;
                    a[i] = s;
                    if (s.InPit) pit = true;
                    if (s.TyresOut > 2) offTrack++;
                    if (s.Speed > maxSpeed) maxSpeed = s.Speed;
                    if (invalidAt < 0 && !s.Valid) { invalidAt = coverage; tAtInvalid = s.T; }
                }
                bool hasCoords = path > 0;

                if (!KeepRunUp && !p.StartedAtLine && p.EndedBy == "line")
                {
                    log.Write("discarded " + n + " samples: the run-up to the start line");
                    return;
                }
                if (p.EndedBy != "line" && (endWall < MinLapSeconds || (hasCoords ? path < 300.0 : coverage < 0.01)))
                {
                    if (n > 600) log.Write("discarded " + n + " samples (" + p.EndedBy + "), too short to keep");
                    return;
                }

                bool complete = coverage >= 0.98;
                // A flag dropped in the last 2.5% is the game ending the timed lap early
                // (e.g. Nordschleife tourist layout), not an invalidation.
                bool valid = complete && (invalidAt < 0 || invalidAt >= 0.975);

                double rate = endWall > 0 ? (n - 1) / endWall : 0;
                double frame = rate > 0 ? 1.0 / rate : 0;
                // Lap timer value at the end of its continuous run from the start of the buffer.
                int k = 0;
                while (k + 1 < n && Math.Abs((a[k + 1].T - a[k].T) - (a[k + 1].Wall - a[k].Wall)) <= 0.5) k++;
                double timerRun = a[k].T > 0 ? a[k].T + (k == n - 1 ? frame : 0) : 0;

                bool gameFresh = gameLapTime > 0 && p.LapTimeRef >= 0 && Math.Abs(gameLapTime - p.LapTimeRef) > 0.0005;
                double upper = (timerRun > 0 ? timerRun : endWall) + 2.0;
                double lapTime;
                string source;
                if (complete && gameFresh && gameLapTime >= MinLapSeconds && gameLapTime <= upper)
                {
                    lapTime = gameLapTime; source = "game";
                }
                else if (timerRun > 0)
                {
                    lapTime = timerRun; source = "samples";
                }
                else
                {
                    lapTime = endWall + frame; source = "wall";
                }

                string track = info.Track + (string.IsNullOrEmpty(info.TrackConfig) ? "" : "_" + info.TrackConfig);
                string dir = Path.Combine(Path.Combine(Path.Combine(Path.Combine(dataDir, "laps"),
                    Sanitize(info.Game)), Sanitize(track)), Sanitize(info.Car));
                Directory.CreateDirectory(dir);

                int minutes = (int)(lapTime / 60.0);
                string name = p.Started.ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture)
                    + "_lap" + p.Lap.ToString("00", CultureInfo.InvariantCulture)
                    + "_" + minutes.ToString(CultureInfo.InvariantCulture)
                    + "." + (lapTime - minutes * 60.0).ToString("00.000", CultureInfo.InvariantCulture)
                    + (complete ? "" : "_partial")
                    + (complete && !valid ? "_invalid" : "");
                string basePath = Path.Combine(dir, name);
                for (int c = 2; File.Exists(basePath + ".csv"); c++) basePath = Path.Combine(dir, name + "_" + c);

                var sb = new StringBuilder(n * 290);
                sb.Append(string.Join(",", Columns)).Append('\n');
                double len = info.TrackLength;
                for (int i = 0; i < n; i++)
                {
                    Sample s = a[i];
                    double metres = hasCoords ? dist[i] : (s.Pos - startPos) * len;
                    sb.Append(F(s.Wall, "0.0000")).Append(',')
                      .Append(F(s.T, "0.000")).Append(',')
                      .Append(F(s.Pos, "0.000000")).Append(',')
                      .Append(F(metres, "0.00")).Append(',')
                      .Append(F(s.X, "0.000")).Append(',')
                      .Append(F(s.Y, "0.000")).Append(',')
                      .Append(F(s.Z, "0.000")).Append(',')
                      .Append(F(s.Speed, "0.00")).Append(',')
                      .Append(F(s.Throttle, "0.0")).Append(',')
                      .Append(F(s.Brake, "0.0")).Append(',')
                      .Append(F(s.Clutch, "0.0")).Append(',')
                      .Append(F(s.Steer, "0.0")).Append(',')
                      .Append(s.Gear.ToString(CultureInfo.InvariantCulture)).Append(',')
                      .Append(F(s.Rpm, "0")).Append(',')
                      .Append(F(s.GLat, "0.000")).Append(',')
                      .Append(F(s.GLon, "0.000")).Append(',')
                      .Append(F(s.Yaw, "0.0000")).Append(',')
                      .Append(s.Abs.ToString(CultureInfo.InvariantCulture)).Append(',')
                      .Append(s.Tc.ToString(CultureInfo.InvariantCulture)).Append(',')
                      .Append(s.TyresOut.ToString(CultureInfo.InvariantCulture)).Append(',')
                      .Append(F(s.SaFL, "0.0000")).Append(',')
                      .Append(F(s.SaFR, "0.0000")).Append(',')
                      .Append(F(s.SaRL, "0.0000")).Append(',')
                      .Append(F(s.SaRR, "0.0000")).Append(',')
                      .Append(F(s.WsFL, "0.000")).Append(',')
                      .Append(F(s.WsFR, "0.000")).Append(',')
                      .Append(F(s.WsRL, "0.000")).Append(',')
                      .Append(F(s.WsRR, "0.000")).Append(',')
                      .Append(s.InPit ? '1' : '0').Append(',')
                      .Append(s.Valid ? '1' : '0').Append(',')
                      .Append(F(s.Kerb, "0.000")).Append(',')
                      .Append(F(s.Heading, "0.0000")).Append(',')
                      .Append(F(s.CpFLx, "0.000")).Append(',').Append(F(s.CpFLy, "0.000")).Append(',').Append(F(s.CpFLz, "0.000")).Append(',')
                      .Append(F(s.CpFRx, "0.000")).Append(',').Append(F(s.CpFRy, "0.000")).Append(',').Append(F(s.CpFRz, "0.000")).Append(',')
                      .Append(F(s.CpRLx, "0.000")).Append(',').Append(F(s.CpRLy, "0.000")).Append(',').Append(F(s.CpRLz, "0.000")).Append(',')
                      .Append(F(s.CpRRx, "0.000")).Append(',').Append(F(s.CpRRy, "0.000")).Append(',').Append(F(s.CpRRz, "0.000")).Append(',')
                      .Append(F(s.Ahead > 0 ? s.Ahead : -1, "0.0")).Append(',').Append(F(s.Behind > 0 ? s.Behind : -1, "0.0")).Append(',')
                      .Append(F(s.Fuel, "0.00")).Append(',').Append(F(s.TyreTemp, "0.0")).Append('\n');
                }
                File.WriteAllText(basePath + ".csv", sb.ToString(), new UTF8Encoding(false));

                var j = new StringBuilder(1400);
                j.Append("{\n");
                JStr(j, "game", info.Game);
                JStr(j, "track", info.Track);
                JStr(j, "track_config", info.TrackConfig);
                JStr(j, "car", info.Car);
                JNum(j, "track_length_m", F(len, "0.0"));
                JStr(j, "session_type", info.SessionType);
                JStr(j, "session_id", info.SessionId);
                JStr(j, "game_version", info.GameVersion);
                JStr(j, "shared_memory_version", info.SmVersion);
                JStr(j, "recorded_at", p.Started.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture));
                JNum(j, "lap_number", p.Lap.ToString(CultureInfo.InvariantCulture));
                JNum(j, "lap_time_s", F(lapTime, "0.000"));
                JStr(j, "lap_time_source", source);
                JNum(j, "game_last_lap_s", F(gameLapTime, "0.000"));
                JNum(j, "timer_run_s", F(timerRun, "0.000"));
                JStr(j, "ended_by", p.EndedBy);
                JNum(j, "complete", complete ? "true" : "false");
                JNum(j, "valid", valid ? "true" : "false");
                JNum(j, "valid_at_end", a[n - 1].Valid ? "true" : "false");
                JNum(j, "invalid_from_coverage", invalidAt < 0 ? "null" : F(invalidAt, "0.0000"));
                JNum(j, "timer_at_invalid_s", invalidAt < 0 ? "null" : F(tAtInvalid, "0.000"));
                JNum(j, "coverage", F(coverage, "0.0000"));
                JNum(j, "path_m", F(path, "0.0"));
                JNum(j, "duration_s", F(endWall, "0.000"));
                JNum(j, "pit", pit ? "true" : "false");
                JNum(j, "had_pause", p.HadPause ? "true" : "false");
                JNum(j, "samples", n.ToString(CultureInfo.InvariantCulture));
                JNum(j, "sample_rate_hz", F(rate, "0.0"));
                JNum(j, "off_track_samples", offTrack.ToString(CultureInfo.InvariantCulture));
                JNum(j, "max_speed_kmh", F(maxSpeed, "0.0"));
                j.Append("  \"columns\": [\"").Append(string.Join("\", \"", Columns)).Append("\"]\n}\n");
                File.WriteAllText(basePath + ".json", j.ToString(), new UTF8Encoding(false));

                Interlocked.Increment(ref lapsSaved);
                lastFile = basePath + ".csv";
                log.Write("saved lap " + p.Lap + " " + F(lapTime, "0.000") + "s (" + source + ")"
                    + (complete ? "" : " partial " + F(coverage * 100.0, "0") + "%") + (complete && !valid ? " invalid" : "")
                    + " ended by " + p.EndedBy
                    + ", " + n + " samples @ " + F(rate, "0.0") + " Hz, " + F(path, "0") + " m -> " + basePath + ".csv");
            }
            catch (Exception ex)
            {
                log.Write("ERROR writing lap: " + ex);
            }
        }

        private static string F(double v, string format)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return "0";
            return v.ToString(format, CultureInfo.InvariantCulture);
        }

        private static void JStr(StringBuilder j, string key, string value)
        {
            j.Append("  \"").Append(key).Append("\": \"");
            foreach (char c in value ?? "")
            {
                if (c == '"' || c == '\\') j.Append('\\').Append(c);
                else if (c < ' ') j.Append(' ');
                else j.Append(c);
            }
            j.Append("\",\n");
        }

        private static void JNum(StringBuilder j, string key, string literal)
        {
            j.Append("  \"").Append(key).Append("\": ").Append(literal).Append(",\n");
        }

        private static string Sanitize(string name)
        {
            if (string.IsNullOrEmpty(name)) return "unknown";
            var sb = new StringBuilder(name.Length);
            foreach (char c in name.Trim())
            {
                bool ok = char.IsLetterOrDigit(c) || c == ' ' || c == '-' || c == '_' || c == '.' || c == '(' || c == ')';
                sb.Append(ok ? c : '_');
            }
            string result = sb.ToString().TrimEnd('.', ' ');
            return result.Length == 0 ? "unknown" : result;
        }
    }
}
