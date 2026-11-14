// The overlay window (transparent, always on top, click-through), its sounds, and the code
// that feeds them: from the game, or from a recorded lap in demo mode. WPF, C# 5 syntax, no
// SimHub types.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace SimCoach
{
    internal sealed class OverlayElement : FrameworkElement
    {
        public CoachState State;
        protected override void OnRender(DrawingContext dc)
        {
            OverlayPainter.Draw(dc, State, VisualTreeHelper.GetDpi(this).PixelsPerDip);
        }
    }

    internal sealed class OverlayWindow : Window
    {
        public readonly OverlayElement View = new OverlayElement();
        /// <summary>Called when the user has dragged the window: where it now is, as shares of the free screen width and height.</summary>
        public Action<double, double> Moved;
        private bool movable, placing;
        private IntPtr handle;

        [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll")] private static extern int SetWindowLong(IntPtr hwnd, int index, int value);
        private const int ExStyle = -20, Transparent = 0x20, ToolWindow = 0x80, NoActivate = 0x08000000;

        public OverlayWindow(double scale, double x, double top)
        {
            Title = "SimCoach overlay";
            WindowStyle = WindowStyle.None; AllowsTransparency = true; Background = Brushes.Transparent;
            Topmost = true; ShowInTaskbar = false; ShowActivated = false; ResizeMode = ResizeMode.NoResize; Focusable = false;
            View.Width = OverlayPainter.Width; View.Height = OverlayPainter.Height;
            Content = View;
            Place(scale, x, top);
            MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e) { if (movable) { try { DragMove(); } catch { } } };
            LocationChanged += delegate
            {
                if (!movable || placing || Moved == null) return;
                double w = SystemParameters.PrimaryScreenWidth - Width, h = SystemParameters.PrimaryScreenHeight - Height;
                Moved(w > 0 ? Math.Max(0, Math.Min(1, Left / w)) : 0.5, h > 0 ? Math.Max(0, Math.Min(1, Top / h)) : 0);
            };
        }

        /// <summary>Size, and where on the main screen: x and top are shares of the room left
        /// beside and below the window (0.5 = centred, 0 = left or top edge, 1 = right or bottom edge).</summary>
        public void Place(double scale, double x, double top)
        {
            placing = true;
            Width = OverlayPainter.Width * scale; Height = OverlayPainter.Height * scale;
            View.LayoutTransform = new ScaleTransform(scale, scale);
            Left = Math.Max(0, (SystemParameters.PrimaryScreenWidth - Width) * x);
            Top = Math.Max(0, (SystemParameters.PrimaryScreenHeight - Height) * top);
            placing = false;
        }

        /// <summary>While it is being placed the window takes the mouse; otherwise every click goes through to the game.</summary>
        public void SetMovable(bool on)
        {
            movable = on;
            Cursor = on ? Cursors.SizeAll : null;
            if (handle != IntPtr.Zero)
            {
                int style = GetWindowLong(handle, ExStyle);
                SetWindowLong(handle, ExStyle, on ? style & ~Transparent : style | Transparent);
            }
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            // stay out of Alt+Tab, never take the keyboard, and (unless being placed) let clicks through
            handle = new WindowInteropHelper(this).Handle;
            SetWindowLong(handle, ExStyle, GetWindowLong(handle, ExStyle) | ToolWindow | NoActivate | (movable ? 0 : Transparent));
        }
    }

    /// <summary>Owns the window on its own UI thread; other threads only hand it the latest state.</summary>
    public sealed class OverlayHost : IDisposable
    {
        private readonly Thread thread;
        private readonly ManualResetEvent ready = new ManualResetEvent(false);
        private readonly double scale, x, top;
        private Dispatcher dispatcher;
        private OverlayWindow window;
        private volatile CoachState latest;
        private long lastUpdateTicks;
        private int frames;
        private volatile bool moving;
        private bool movingApplied;
        public string Error;
        // where the user dragged the window to, until the owner picks it up
        private readonly object movedGate = new object();
        private bool moved;
        private double movedX, movedTop;

        // what the window shows while it is being placed: its real size, with a line saying what to do
        private static readonly CoachState Sample = new CoachState
        {
            Active = true, Corner = "USTAW POŁOŻENIE", Phase = 1, Progress = 0.55, ToCorner = 120, TargetSpeed = 105, Delta = -0.21,
            Message = "Złap okno myszą i przeciągnij", MessageKind = 1
        };

        public OverlayHost(double scale, double x, double top)
        {
            this.scale = scale; this.x = x; this.top = top;
            thread = new Thread(Run);
            thread.IsBackground = true; thread.Name = "SimCoach overlay";
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            ready.WaitOne(5000);
        }

        private void Run()
        {
            try
            {
                window = new OverlayWindow(scale, x, top);
                window.Moved = delegate(double mx, double mt) { lock (movedGate) { moved = true; movedX = mx; movedTop = mt; } };
                dispatcher = Dispatcher.CurrentDispatcher;
                var timer = new DispatcherTimer();
                timer.Interval = TimeSpan.FromMilliseconds(33);
                timer.Tick += Tick;
                timer.Start();
                ready.Set();
                Dispatcher.Run();
            }
            catch (Exception ex) { Error = ex.ToString(); ready.Set(); }
        }

        private void Tick(object sender, EventArgs e)
        {
            bool move = moving;
            if (move != movingApplied) { window.SetMovable(move); movingApplied = move; }
            CoachState s = latest;
            // nothing new for a moment (pause, menu, game closed): get out of the way
            bool live = s != null && DateTime.UtcNow.Ticks - Interlocked.Read(ref lastUpdateTicks) < TimeSpan.TicksPerSecond * 3 / 2;
            if (!live && !move) { if (window.IsVisible) window.Hide(); return; }
            if (!window.IsVisible) window.Show();
            window.View.State = live ? s : Sample;
            window.View.InvalidateVisual();
            if (++frames % 90 == 0) { window.Topmost = false; window.Topmost = true; } // games like to climb back on top
        }

        public void Update(CoachState state)
        {
            latest = state;
            Interlocked.Exchange(ref lastUpdateTicks, DateTime.UtcNow.Ticks);
        }

        public void Hide() { latest = null; }

        /// <summary>Placing mode: the window is shown whatever happens and can be dragged with the mouse.</summary>
        public void SetMove(bool on) { moving = on; }

        public bool TakeMoved(out double newX, out double newTop)
        {
            lock (movedGate) { newX = movedX; newTop = movedTop; bool was = moved; moved = false; return was; }
        }

        public void Place(double newScale, double newX, double newTop)
        {
            if (dispatcher != null) dispatcher.BeginInvoke(new Action(() => window.Place(newScale, newX, newTop)));
        }

        public void Dispose()
        {
            if (dispatcher == null) return;
            dispatcher.BeginInvoke(new Action(() => { window.Close(); Dispatcher.CurrentDispatcher.InvokeShutdown(); }));
        }
    }

    /// <summary>
    /// Finds the guide for the track and car being driven, runs the coach engine on each frame
    /// and keeps the overlay and its sounds up to date. Also plays a recorded lap through the
    /// same path when the app asks for a demo (data\overlay.demo.txt: the guide, then the lap's
    /// CSV files).
    /// </summary>
    public sealed class CoachRunner : IDisposable
    {
        private readonly string dataDir;
        private readonly Logger log;
        private readonly object gate = new object();
        private OverlayHost host;
        private CoachEngine engine;
        private SoundBank bank;
        private string guideKey = "", guideFile = "";
        private DateTime guideStamp;
        private double nextGuideCheck, hideAfter;
        private Thread demo;
        private volatile bool demoStop;
        // settings (data\overlay.txt)
        private double scale = 1.0, x = 0.5, top = 0.04, volume = 0.6;
        private int sound = 2;       // 0 off, 1 a tone at the braking and throttle points, 2 with two ticks counting down to the braking point
        private int theme = 1;       // which set of sounds (SoundBank.Themes)
        private bool move;           // the window is being placed with the mouse
        private DateTime configStamp;
        private int soundErrors;

        public volatile bool Enabled = true;
        public volatile CoachState Last = new CoachState();
        public bool DemoRunning { get { return demo != null && demo.IsAlive; } }
        /// <summary>How many corners the loaded plan speaks about; -1 with no plan loaded.</summary>
        public int GuideCorners { get { CoachEngine e = engine; return e == null ? -1 : e.Guide.Corners.Count; } }

        public CoachRunner(string dataDir, Logger log)
        {
            this.dataDir = dataDir; this.log = log;
            try { File.Delete(DemoFile); File.Delete(BeepFile); } catch { } // requests left over from before SimHub was closed
            ReadConfig();
            if (move) { move = false; try { WriteConfig(); } catch { } } // never start with a window that takes the mouse
        }

        private string ConfigFile { get { return Path.Combine(dataDir, "overlay.txt"); } }
        private string DemoFile { get { return Path.Combine(dataDir, "overlay.demo.txt"); } }
        private string BeepFile { get { return Path.Combine(dataDir, "overlay.beep.txt"); } }
        private string StateFile { get { return Path.Combine(dataDir, "overlay.state.txt"); } }
        private long lastFrameTicks;

        private static string Num(double v) { return v.ToString("0.####", CultureInfo.InvariantCulture); }

        private void WriteConfig()
        {
            File.WriteAllText(ConfigFile, "enabled=" + (Enabled ? "1" : "0") + "\r\nscale=" + Num(scale) + "\r\nx=" + Num(x) + "\r\ntop=" + Num(top)
                + "\r\nsound=" + sound.ToString(CultureInfo.InvariantCulture) + "\r\nvolume=" + Num(volume) + "\r\ntheme=" + theme.ToString(CultureInfo.InvariantCulture) + "\r\nmove=" + (move ? "1" : "0") + "\r\n");
            configStamp = File.GetLastWriteTimeUtc(ConfigFile);
        }

        // data\overlay.txt:
        //   enabled=1    show the window while driving (0: sounds only, if those are on)
        //   scale=1.0    size
        //   x=0.5 top=0.04   where on the main screen: 0 = left / top edge, 1 = right / bottom edge
        //   sound=2      0 off, 1 tones at the points, 2 with a count-down to the braking point
        //   volume=0.6   0..1
        //   theme=1      the set of sounds: 0 soft, 1 race, 2 neon, 3 pulse, 4 own files (data\sounds\tick.wav, brake.wav, gas.wav, lift.wav)
        //   move=0       1 while the window is being dragged into place
        private void ReadConfig()
        {
            try
            {
                if (!File.Exists(ConfigFile)) { WriteConfig(); return; }
                DateTime stamp = File.GetLastWriteTimeUtc(ConfigFile);
                if (stamp == configStamp) return;
                configStamp = stamp;
                double oldScale = scale, oldX = x, oldTop = top;
                foreach (string line in File.ReadAllLines(ConfigFile))
                {
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string k = line.Substring(0, eq).Trim(), v = line.Substring(eq + 1).Trim();
                    double n;
                    bool num = double.TryParse(v.Replace(',', '.'), NumberStyles.Float, CultureInfo.InvariantCulture, out n);
                    if (k == "enabled") Enabled = v != "0";
                    else if (k == "move") move = v == "1";
                    else if (k == "scale" && num) scale = Math.Max(0.5, Math.Min(3.0, n));
                    else if (k == "x" && num) x = Math.Max(0.0, Math.Min(1.0, n));
                    else if (k == "top" && num) top = Math.Max(0.0, Math.Min(1.0, n));
                    else if (k == "sound" && num) sound = (int)Math.Max(0, Math.Min(2, n));
                    else if (k == "volume" && num) volume = Math.Max(0.05, Math.Min(1.0, n));
                    else if (k == "theme" && num) theme = (int)Math.Max(0, Math.Min(SoundBank.Themes.Length - 1, n));
                }
                if (host != null && (oldScale != scale || oldX != x || oldTop != top)) host.Place(scale, x, top);
                if (!Enabled && host != null && !DemoRunning) host.Hide();
            }
            catch (Exception ex) { log.Write("overlay config: " + ex.Message); }
        }

        private OverlayHost Host()
        {
            if (host == null)
            {
                host = new OverlayHost(scale, x, top);
                if (host.Error != null) log.Write("ERROR overlay window: " + host.Error);
                else log.Write("overlay window ready (scale " + scale.ToString(CultureInfo.InvariantCulture) + ")");
            }
            return host;
        }

        // kind: what the engine asked for (1 tick, 2 braking point, 3 throttle point, 4 lift point)
        private void Beep(int kind)
        {
            if (kind == 0 || sound == 0 || (kind == 1 && sound < 2)) return;
            try
            {
                if (bank == null || bank.Volume != volume || bank.Theme != theme) { if (bank != null) bank.Dispose(); bank = new SoundBank(volume, theme, Path.Combine(dataDir, "sounds")); }
                bank.Play(kind);
            }
            catch (Exception ex) { if (soundErrors++ < 3) log.Write("overlay sound: " + ex.Message); }
        }

        // The guide written for this game, track, layout and car, if the app has made one.
        private void FindGuide(SessionInfo info)
        {
            string key = info.Key(), dir = Path.Combine(dataDir, "guides");
            try
            {
                if (!Directory.Exists(dir)) { engine = null; guideKey = key; return; }
                foreach (string file in Directory.GetFiles(dir, "*.guide.txt"))
                {
                    var head = new Dictionary<string, string>();
                    using (var r = new StreamReader(file))
                    {
                        string line;
                        for (int i = 0; i < 24 && (line = r.ReadLine()) != null && line != "[line]"; i++)
                        {
                            int eq = line.IndexOf('=');
                            if (eq > 0) head[line.Substring(0, eq)] = line.Substring(eq + 1).Trim();
                        }
                    }
                    string g, t, c, car;
                    head.TryGetValue("game", out g); head.TryGetValue("track", out t); head.TryGetValue("config", out c); head.TryGetValue("car", out car);
                    if (g != info.Game || t != info.Track || (c ?? "") != info.TrackConfig || car != info.Car) continue;
                    DateTime stamp = File.GetLastWriteTimeUtc(file);
                    if (engine != null && file == guideFile && stamp == guideStamp && key == guideKey) return; // already loaded
                    // A plan written again while a lap is being driven (after every lap the app
                    // brings it up to date by itself) waits for the lap to end: the points must not move under the driver.
                    if (engine != null && file == guideFile && key == guideKey && Last.OnLap) return;
                    var fresh = new CoachEngine(Guide.Load(file));
                    if (engine != null && file == guideFile && key == guideKey) fresh.Adopt(engine); // the plan was rewritten mid-lap
                    engine = fresh;
                    guideFile = file; guideStamp = stamp; guideKey = key;
                    log.Write("overlay guide loaded: " + Path.GetFileName(file) + " (" + engine.Guide.Corners.Count + " corners)");
                    return;
                }
                if (engine != null || guideKey != key) log.Write("no overlay guide for " + key);
                engine = null; guideKey = key;
            }
            catch (Exception ex) { log.Write("ERROR loading overlay guide: " + ex.Message); engine = null; guideKey = key; }
        }

        /// <summary>One live frame from the game.</summary>
        public void Frame(double now, SessionInfo info, double x, double z, double speed, double brake, double throttle)
        {
            Interlocked.Exchange(ref lastFrameTicks, DateTime.UtcNow.Ticks);
            if (DemoRunning) return;
            lock (gate)
            {
                // driving has begun: a window still being placed must not sit there taking the mouse
                if (move) { move = false; if (host != null) host.SetMove(false); try { WriteConfig(); } catch { } }
                if (!Enabled && sound == 0) { if (host != null) host.Hide(); return; }
                if (now >= nextGuideCheck || guideKey != info.Key()) { nextGuideCheck = now + 3.0; FindGuide(info); }
                if (engine == null) return;
                CoachState st = engine.Update(now, x, z, speed, brake, throttle);
                // Only a timed lap is coached: from the start line to the finish line. The drive
                // from the car park to the line, and back to it after the finish, gets neither
                // window nor sounds.
                if (st.OnLap) Beep(st.Sound);
                Last = st.Clone();
                if (st.Active && st.OnLap) hideAfter = now + 0.7;
                if (Enabled && now < hideAfter) Host().Update(Last); else if (host != null) host.Hide();
            }
        }

        /// <summary>Once a second, from a timer: settings changed? window dragged? demo or a sound sample asked for?</summary>
        public void Tick()
        {
            lock (gate)
            {
                ReadConfig();
                if (move || host != null)
                {
                    OverlayHost h = move ? Host() : host;
                    h.SetMove(move);
                    double nx, nt;
                    if (h.TakeMoved(out nx, out nt) && (Math.Abs(nx - x) > 0.0005 || Math.Abs(nt - top) > 0.0005))
                    {
                        x = nx; top = nt;
                        try { WriteConfig(); } catch { }
                    }
                }
            }
            try
            {
                bool wanted = File.Exists(DemoFile);
                if (wanted && !DemoRunning)
                {
                    string[] lines = File.ReadAllLines(DemoFile);
                    demoStop = false;
                    demo = new Thread(() => PlayDemo(lines));
                    demo.IsBackground = true; demo.Name = "SimCoach overlay demo";
                    demo.Start();
                }
                else if (!wanted && DemoRunning) demoStop = true;
            }
            catch (Exception ex) { log.Write("overlay demo: " + ex.Message); }
            try
            {
                if (File.Exists(BeepFile))
                {
                    File.Delete(BeepFile);
                    // the sounds as they come at a corner: tick, tick, braking point... throttle point
                    var sample = new Thread(delegate()
                    {
                        Beep(1); Thread.Sleep(450); Beep(1); Thread.Sleep(450); Beep(2); Thread.Sleep(1300); Beep(3); Thread.Sleep(1300); Beep(4);
                    });
                    sample.IsBackground = true;
                    sample.Start();
                }
            }
            catch (Exception ex) { log.Write("overlay sound sample: " + ex.Message); }
            // A sign of life for the app: it reads this file's age to tell whether the plugin is running.
            try
            {
                bool driving = DateTime.UtcNow.Ticks - Interlocked.Read(ref lastFrameTicks) < TimeSpan.TicksPerSecond * 2;
                File.WriteAllText(StateFile, "demo=" + (DemoRunning ? "1" : "0") + "\nenabled=" + (Enabled ? "1" : "0")
                    + "\nfeatures=sound,move,lift,themes,laponly,traffic,autoplan\ndriving=" + (driving ? "1" : "0") + "\nguide=" + (driving && engine != null ? Path.GetFileName(guideFile) : "") + "\n");
            }
            catch { /* the app is reading it right now: the next second will do */ }
        }

        // Plays recorded lap files through the engine at the speed they were driven.
        private void PlayDemo(string[] lines)
        {
            try
            {
                var eng = new CoachEngine(Guide.Load(lines[0].Trim()));
                log.Write("overlay demo started");
                OverlayHost h;
                lock (gate) { h = Host(); }
                if (h.Error != null) return;
                var watch = System.Diagnostics.Stopwatch.StartNew();
                double offset = 0;
                for (int f = 1; f < lines.Length && !demoStop; f++)
                {
                    if (lines[f].Trim().Length == 0) continue;
                    string[] rows = File.ReadAllLines(lines[f].Trim());
                    string[] head = rows[0].Trim().Split(',');
                    var ix = new Dictionary<string, int>();
                    for (int i = 0; i < head.Length; i++) ix[head[i]] = i;
                    double lastWall = 0;
                    for (int r = 1; r < rows.Length && !demoStop; r++)
                    {
                        string[] c = rows[r].Split(',');
                        Func<string, double> v = name => double.Parse(c[ix[name]], CultureInfo.InvariantCulture);
                        double wall = v("wall"), px = v("x"), pz = v("z");
                        lastWall = wall;
                        if (px == 0 && pz == 0)
                        {
                            px = (v("cp_fl_x") + v("cp_fr_x") + v("cp_rl_x") + v("cp_rr_x")) / 4;
                            pz = (v("cp_fl_z") + v("cp_fr_z") + v("cp_rl_z") + v("cp_rr_z")) / 4;
                            if (px == 0 && pz == 0) continue;
                        }
                        double due = offset + wall, wait = due - watch.Elapsed.TotalSeconds;
                        if (wait > 0.002) Thread.Sleep((int)(wait * 1000));
                        CoachState st = eng.Update(due, px, pz, v("speed"), v("brake"), v("throttle"));
                        Beep(st.Sound);
                        Last = st.Clone();
                        h.Update(Last);
                    }
                    offset += lastWall + 1.0 / 60.0;
                }
                h.Hide();
            }
            catch (Exception ex) { log.Write("ERROR overlay demo: " + ex.Message); }
            finally
            {
                try { File.Delete(DemoFile); } catch { }
                log.Write("overlay demo ended");
            }
        }

        public void Toggle()
        {
            lock (gate)
            {
                Enabled = !Enabled;
                if (!Enabled && host != null) host.Hide();
                try { WriteConfig(); } catch { }
                log.Write("overlay " + (Enabled ? "on" : "off"));
            }
        }

        public void Dispose()
        {
            demoStop = true;
            lock (gate) { if (host != null) { host.Dispose(); host = null; } if (bank != null) { bank.Dispose(); bank = null; } }
            try { File.Delete(StateFile); } catch { }
        }
    }
}
