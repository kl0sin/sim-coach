// SimHub plugin: feeds every live telemetry frame into LapRecorder.
// Uses SimHub's normalized data (works for any supported game) plus AC Evo raw
// fields for steering, tyre slip and track limits. C# 5 syntax only.
using System;
using System.Diagnostics;
using GameReaderCommon;
using SimHub.Plugins;

namespace SimCoach
{
    [PluginDescription("Records per-lap telemetry to CSV for post-session coaching analysis")]
    [PluginAuthor("SimCoach")]
    [PluginName("SimCoach Recorder")]
    public class SimCoachPlugin : IPlugin, IDataPlugin, IWPFSettingsV2
    {
        private AppServer appServer;
        private readonly SessionInfo info = new SessionInfo();
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private Logger log;
        private LapRecorder recorder;
        private System.Threading.Timer idleTimer;
        private CoachRunner coach;
        private PlanRefresher refresher;
        private int ticking;
        private bool live;
        private bool rawFailed;
        private string describedKey;
        private int errors;
        private int carsSeen;

        public PluginManager PluginManager { get; set; }

        // The SimCoach page in SimHub's left menu.
        public string LeftMenuTitle { get { return "SimCoach"; } }

        public System.Windows.Media.ImageSource PictureIcon
        {
            get { return SettingsPanel.Mark(System.Windows.Media.Color.FromArgb(150, 255, 255, 255), System.Windows.Media.Color.FromRgb(0xff, 0xd6, 0x0a)); }
        }

        public System.Windows.Controls.Control GetWPFSettingsControl(PluginManager pluginManager)
        {
            return new SettingsPanel(
                delegate
                {
                    var s = new PanelState();
                    s.Server = appServer == null ? "starting" : appServer.State;
                    s.Recording = live;
                    s.Track = info.Track ?? ""; s.Car = info.Car ?? "";
                    s.LapsSaved = recorder == null ? 0 : recorder.LapsSaved;
                    s.GuideCorners = coach == null ? -1 : coach.GuideCorners;
                    s.OverlayOn = coach != null && coach.Enabled;
                    return s;
                },
                delegate(string route) { return appServer == null ? "starting" : appServer.OpenWindow(route); },
                delegate { if (coach != null) coach.Toggle(); },
                System.IO.Path.Combine(BuildConfig.DataDir, "simcoach.log"));
        }

        public void Init(PluginManager pluginManager)
        {
            log = new Logger(System.IO.Path.Combine(BuildConfig.DataDir, "simcoach.log"));
            recorder = new LapRecorder(BuildConfig.DataDir, log);
            log.Write("plugin started, data dir: " + BuildConfig.DataDir);

            // SimHub does not call End() when Windows closes it (logoff, installer, app update),
            // so save the lap in progress from these hooks as well.
            Microsoft.Win32.SystemEvents.SessionEnding += OnSessionEnding;
            AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
            // When the game is closed SimHub simply stops sending frames, so a timer saves the
            // recording once nothing has arrived for 20 seconds.
            // The same timer lets the overlay notice a demo request or changed settings.
            coach = new CoachRunner(BuildConfig.DataDir, log);
            refresher = new PlanRefresher(BuildConfig.DataDir, log);
            // The app's server runs for as long as SimHub does, so the app only has to be opened.
            appServer = new AppServer(BuildConfig.DataDir, log.Write);
            idleTimer = new System.Threading.Timer(delegate
            {
                // (a tick that takes longer than a second must not run into the next one)
                if (System.Threading.Interlocked.Exchange(ref ticking, 1) == 1) return;
                try
                {
                    try { recorder.FlushIfIdle(clock.Elapsed.TotalSeconds, 20.0); } catch { }
                    try { coach.Tick(); } catch { }
                    try { refresher.Tick(recorder.LapsSaved); } catch { }
                }
                finally { System.Threading.Interlocked.Exchange(ref ticking, 0); }
            }, null, 1000, 1000);

            // What the overlay shows, for anyone who prefers to build their own SimHub dashboard.
            this.AttachDelegate("Coach.Corner", () => coach.Last.Corner);
            this.AttachDelegate("Coach.MetresToPoint", () => double.IsNaN(coach.Last.ToCorner) ? -1.0 : coach.Last.ToCorner);
            this.AttachDelegate("Coach.Countdown", () => coach.Last.Countdown);
            this.AttachDelegate("Coach.BrakeNow", () => coach.Last.BrakeNow);
            this.AttachDelegate("Coach.ThrottleNow", () => coach.Last.GasNow);
            this.AttachDelegate("Coach.Phase", () => coach.Last.Phase);
            this.AttachDelegate("Coach.TargetSpeed", () => double.IsNaN(coach.Last.TargetSpeed) ? 0.0 : coach.Last.TargetSpeed);
            this.AttachDelegate("Coach.Delta", () => double.IsNaN(coach.Last.Delta) ? 0.0 : coach.Last.Delta);
            this.AttachDelegate("Coach.Message", () => coach.Last.Message);
            this.AttachDelegate("Coach.OverlayOn", () => coach.Enabled);
            this.AddAction("ToggleOverlay", (a, b) => coach.Toggle(), (a, b) => { });

            this.AttachDelegate("Recording", () => live);
            this.AttachDelegate("LapsSaved", () => recorder.LapsSaved);
            this.AttachDelegate("BufferedSamples", () => recorder.BufferedSamples);
            this.AttachDelegate("LastFile", () => recorder.LastFile);
        }

        public void End(PluginManager pluginManager)
        {
            Microsoft.Win32.SystemEvents.SessionEnding -= OnSessionEnding;
            AppDomain.CurrentDomain.ProcessExit -= OnProcessExit;
            if (idleTimer != null) { idleTimer.Dispose(); idleTimer = null; }
            if (refresher != null) refresher.Stop();
            if (appServer != null) appServer.Stop();
            if (coach != null) coach.Dispose();
            if (recorder != null) recorder.Shutdown("shutdown");
            if (log != null) log.Write("plugin stopped");
        }

        private void OnSessionEnding(object sender, Microsoft.Win32.SessionEndingEventArgs e)
        {
            SaveOnExit("windows session ending");
        }

        private void OnProcessExit(object sender, EventArgs e)
        {
            SaveOnExit("process exit");
        }

        private void SaveOnExit(string reason)
        {
            try
            {
                if (log != null) log.Write("saving on " + reason);
                if (recorder != null) recorder.Shutdown(reason);
            }
            catch { /* nothing useful can be done while the process is going down */ }
        }

        public void DataUpdate(PluginManager pluginManager, ref GameData data)
        {
            try
            {
                StatusDataBase d = data.NewData;
                if (!data.GameRunning || d == null || data.GamePaused || data.GameInMenu || data.GameReplay || d.Spectating)
                {
                    live = false;
                    recorder.Suspend();
                    return;
                }

                info.RawLastLap = -1;
                info.Game = data.GameName ?? "";
                info.Track = d.TrackName ?? "";
                info.TrackConfig = d.TrackConfig ?? "";
                info.Car = string.IsNullOrEmpty(d.CarModel) ? (d.CarId ?? "") : d.CarModel;
                info.SessionType = d.SessionTypeName ?? "";
                info.SessionId = data.SessionId.ToString();
                info.TrackLength = d.TrackLength;

                var s = new Sample();
                s.T = d.CurrentLapTime.TotalSeconds;
                s.Pos = d.TrackPositionPercent;
                double[] xyz = d.CarCoordinates;
                if (xyz != null && xyz.Length >= 3) { s.X = xyz[0]; s.Y = xyz[1]; s.Z = xyz[2]; }
                s.Speed = d.SpeedKmh;
                s.Throttle = d.Throttle;
                s.Brake = d.Brake;
                s.Clutch = d.Clutch;
                s.Gear = ParseGear(d.Gear);
                s.Rpm = d.Rpms;
                s.GLat = d.AccelerationSway.GetValueOrDefault();
                s.GLon = d.AccelerationSurge.GetValueOrDefault();
                s.Yaw = d.OrientationYaw;
                s.Abs = d.ABSActive;
                s.Tc = d.TCActive;
                s.InPit = d.IsInPitLane != 0 || d.IsInPit != 0;
                s.Valid = d.IsLapValid;
                s.Fuel = d.Fuel;
                s.TyreTemp = (d.TyreTemperatureFrontLeft + d.TyreTemperatureFrontRight + d.TyreTemperatureRearLeft + d.TyreTemperatureRearRight) / 4.0;
                try { Traffic(d, ref s); } catch { s.Ahead = -1; s.Behind = -1; }

                object raw = null;
                bool onTrack = true;
                if (!rawFailed)
                {
                    raw = d.GetRawDataObject();
                    if (raw != null && raw.GetType().FullName == EvoRaw.TypeName)
                    {
                        try { onTrack = EvoRaw.Fill(raw, ref s, info); }
                        catch (Exception ex)
                        {
                            // SimHub changed its AC Evo structures: keep recording the normalized data.
                            rawFailed = true;
                            log.Write("AC Evo raw data disabled: " + ex.GetType().Name + ": " + ex.Message);
                        }
                    }
                }
                if (!onTrack)
                {
                    live = false;
                    recorder.Suspend();
                    return;
                }

                string key = info.Key();
                if (key != describedKey)
                {
                    describedKey = key;
                    log.Write("session: " + key + " | length " + d.TrackLength.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture)
                        + " m | session " + info.SessionType
                        + " | raw " + (raw == null ? "none" : raw.GetType().FullName)
                        + " | game " + info.GameVersion + " sm " + info.SmVersion
                        + " | lap " + d.CurrentLap
                        + " pos " + s.Pos.ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture)
                        + " xyz " + s.X.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture)
                        + "/" + s.Y.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture)
                        + "/" + s.Z.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture));
                }

                live = true;
                bool evo = info.RawLastLap >= 0;
                double now = clock.Elapsed.TotalSeconds;
                recorder.Update(now, s,
                    evo ? -1 : d.CurrentLap,
                    evo ? info.RawLastLap : d.LastLapTime.TotalSeconds, info);
                // The overlay is a convenience: whatever goes wrong in it must not cost a recording.
                try { if (s.X != 0 || s.Z != 0) coach.Frame(now, info, s.X, s.Z, s.Speed, s.Brake, s.Throttle); }
                catch (Exception ex) { if (errors++ < 5) log.Write("ERROR in overlay: " + ex); }
            }
            catch (Exception ex)
            {
                if (errors++ < 5 && log != null) log.Write("ERROR in DataUpdate: " + ex);
            }
        }

        // How far along the track the nearest other cars are, in front and behind. A slower car
        // ahead explains a slow corner that the driver did nothing wrong in; the app leaves such
        // corners out when it works out the plan.
        private void Traffic(StatusDataBase d, ref Sample s)
        {
            s.Ahead = -1; s.Behind = -1;
            var cars = d.Opponents;
            if (cars == null || d.TrackLength <= 0) return;
            double ahead = double.MaxValue, behind = double.MaxValue;
            int placed = 0;
            foreach (Opponent o in cars)
            {
                if (o == null || o.IsPlayer || o.IsCarInPit || o.IsCarInPitLane || !o.TrackPositionPercent.HasValue) continue;
                double theirs = o.TrackPositionPercent.Value;
                if (theirs > 1.5) theirs /= 100.0; // some games count in percent
                double diff = theirs - s.Pos;
                diff -= Math.Floor(diff);
                double m = diff * d.TrackLength;
                if (m < 1.5 || d.TrackLength - m < 1.5) continue; // on top of the player: the player's own entry
                placed++;
                if (diff < 0.5) { if (m < ahead) ahead = m; }
                else if (d.TrackLength - m < behind) behind = d.TrackLength - m;
            }
            if (ahead < double.MaxValue) s.Ahead = ahead;
            if (behind < double.MaxValue) s.Behind = behind;
            if (placed > carsSeen)
            {
                if (carsSeen == 0) log.Write("other cars on track: positions available (" + placed + " of " + cars.Count + " listed)");
                carsSeen = placed;
            }
        }

        private static int ParseGear(string gear)
        {
            if (string.IsNullOrEmpty(gear) || gear == "N") return 0;
            if (gear == "R") return -1;
            int value;
            return int.TryParse(gear, out value) ? value : 0;
        }
    }
}
