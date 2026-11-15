// Runs the SimCoach app the way a desktop program runs: the Node.js server hidden in the
// background and the page in a window of its own (a browser's "app" window: no tabs, no address
// bar, its own taskbar icon). Shared by the SimHub plugin, which keeps the server up for as long
// as SimHub is open, and by the launcher (SimCoach.exe). C# 5 syntax only.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Threading;

namespace SimCoach
{
    public enum Port { Free, Ours, Taken }

    public static class AppHost
    {
        public static int PortNumber
        {
            get
            {
                int port;
                return int.TryParse(Environment.GetEnvironmentVariable("SIMCOACH_PORT"), out port) && port > 0 ? port : 8377;
            }
        }

        /// <summary>The app's address; route is the part after "#", e.g. "/overlay".</summary>
        public static string Url(string route)
        {
            return "http://localhost:" + PortNumber + "/" + (string.IsNullOrEmpty(route) ? "" : "#" + route);
        }

        /// <summary>The folder that holds app\server.js, looking upwards from a starting folder.</summary>
        public static string FindRepo(string from)
        {
            for (var dir = new DirectoryInfo(from); dir != null; dir = dir.Parent)
                if (File.Exists(Path.Combine(dir.FullName, "app", "server.js"))) return dir.FullName;
            return null;
        }

        /// <summary>Who answers on the app's port: nobody, a SimCoach server, or something else.</summary>
        public static Port Probe(int timeoutMs)
        {
            // Asked of Windows first: connecting to a port nobody listens on takes two seconds to fail.
            try
            {
                bool listening = false;
                foreach (IPEndPoint ep in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
                    if (ep.Port == PortNumber) { listening = true; break; }
                if (!listening) return Port.Free;
            }
            catch { }
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + PortNumber + "/api/ping");
                req.Proxy = null; req.Timeout = timeoutMs; req.ReadWriteTimeout = timeoutMs; req.KeepAlive = false;
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var reader = new StreamReader(res.GetResponseStream()))
                    return reader.ReadToEnd().IndexOf("\"simcoach\"", StringComparison.Ordinal) >= 0 ? Port.Ours : Port.Taken;
            }
            catch (WebException ex)
            {
                // an answer of any kind (an older SimCoach says 404 here) means the port is in use
                return ex.Response != null || ex.Status == WebExceptionStatus.Timeout ? Port.Taken : Port.Free;
            }
            catch { return Port.Free; }
        }

        /// <summary>
        /// Whether the SimCoach server now answering was started before the app's files last
        /// changed: it still runs the old code. False when that cannot be told.
        /// </summary>
        public static bool Stale(string repo)
        {
            try
            {
                string body;
                using (var web = new WebClient()) { web.Proxy = null; body = web.DownloadString("http://127.0.0.1:" + PortNumber + "/api/ping"); }
                int at = body.IndexOf("\"started\":\"", StringComparison.Ordinal);
                if (at < 0) return false;
                at += 11;
                DateTime started = DateTime.Parse(body.Substring(at, body.IndexOf('"', at) - at), System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();
                return CodeStamp(repo) > started;
            }
            catch { return false; }
        }

        /// <summary>Asks the running SimCoach server to end, and waits until the port is free. False if it stays.</summary>
        public static bool Quit()
        {
            try
            {
                using (var web = new WebClient()) { web.Proxy = null; web.UploadString("http://127.0.0.1:" + PortNumber + "/api/quit", ""); }
            }
            catch { return false; } // an older server does not know the request
            DateTime until = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < until) { if (Probe(1000) == Port.Free) return true; Thread.Sleep(150); }
            return false;
        }

        /// <summary>
        /// Starts the server without a console window. When tied, it stops by itself once the
        /// process that started it is gone and the app's window is closed. Throws when Node.js is
        /// not installed.
        /// </summary>
        public static Process StartServer(string repo, bool tied, Action<string> onError)
        {
            string script = Path.Combine(repo, "app", "server.js");
            var info = new ProcessStartInfo("node", "\"" + script + "\"" + (tied ? " --parent " + Process.GetCurrentProcess().Id : ""));
            info.UseShellExecute = false; info.CreateNoWindow = true;
            info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            info.WorkingDirectory = repo;
            var p = new Process();
            p.StartInfo = info;
            int told = 0;
            p.OutputDataReceived += delegate { }; // read and dropped, so the server never waits on a full pipe
            p.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (!string.IsNullOrEmpty(e.Data) && onError != null && Interlocked.Increment(ref told) <= 12) onError(e.Data);
            };
            p.Start();
            p.BeginOutputReadLine(); p.BeginErrorReadLine();
            try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { } // the game comes first
            return p;
        }

        /// <summary>Waits until a SimCoach server answers; false when it has not within the time given.</summary>
        public static bool WaitForServer(Process server, int seconds)
        {
            DateTime until = DateTime.UtcNow.AddSeconds(seconds);
            while (DateTime.UtcNow < until)
            {
                if (Probe(1000) == Port.Ours) return true;
                if (server != null && server.HasExited) return Probe(1000) == Port.Ours;
                Thread.Sleep(150);
            }
            return false;
        }

        /// <summary>When any of the server's own files was last changed (a running server keeps the old code).</summary>
        public static DateTime CodeStamp(string repo)
        {
            DateTime newest = DateTime.MinValue;
            try
            {
                foreach (string dir in new[] { Path.Combine(repo, "app"), Path.Combine(repo, "app", "lib") })
                    foreach (string file in Directory.GetFiles(dir, "*.js"))
                    {
                        DateTime t = File.GetLastWriteTimeUtc(file);
                        if (t > newest) newest = t;
                    }
            }
            catch { }
            return newest;
        }

        private static string FindBrowser()
        {
            string[] roots =
            {
                Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("ProgramFiles"),
                Environment.GetEnvironmentVariable("LocalAppData")
            };
            string[] apps = { @"Microsoft\Edge\Application\msedge.exe", @"Google\Chrome\Application\chrome.exe" };
            foreach (string app in apps)
                foreach (string root in roots)
                {
                    if (string.IsNullOrEmpty(root)) continue;
                    string path = Path.Combine(root, app);
                    if (File.Exists(path)) return path;
                }
            return null;
        }

        /// <summary>Whether a browser that can show the app in a window of its own is installed.</summary>
        public static bool HasAppWindow { get { return FindBrowser() != null; } }

        // The window's browser profile. The server looks for the same folder (app\server.js).
        private static string WindowProfile(string dataDir) { return Path.Combine(dataDir, "window"); }

        /// <summary>Whether the app's window is open: the browser holds "lockfile" in its profile while it runs.</summary>
        public static bool WindowOpen(string dataDir)
        {
            try { return File.Exists(Path.Combine(WindowProfile(dataDir), "lockfile")); } catch { return false; }
        }

        /// <summary>
        /// Opens the app in a window of its own and returns the browser process behind it. When a
        /// window is already open the browser hands the request to it and the returned process
        /// ends at once. Returns null when neither Edge nor Chrome is installed: the page then
        /// opens in the default browser.
        /// </summary>
        public static Process OpenWindow(string dataDir, string route)
        {
            string url = Url(route), browser = FindBrowser();
            if (browser == null)
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                return null;
            }
            // A profile of its own: the window is then not a tab of the browser the driver uses
            // every day, it keeps its own size and place, and no extension can get at the page.
            string profile = WindowProfile(dataDir);
            Directory.CreateDirectory(profile);
            var info = new ProcessStartInfo(browser,
                "--app=\"" + url + "\" --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check"
                + " --disable-sync --disable-features=msEdgeSidebarV2,Translate --window-size=1600,1000");
            info.UseShellExecute = false;
            return Process.Start(info);
        }
    }

    /// <summary>
    /// Keeps the server running for the plugin: starts it when nothing answers on the port, starts
    /// it again if it stops or its files change, and leaves alone a server somebody else started.
    /// </summary>
    public sealed class AppServer
    {
        private readonly string repo, dataDir;
        private readonly Action<string> log;
        private readonly object gate = new object();
        private Timer timer;
        private Process owned;
        private DateTime startedAt, codeStamp, askedToQuit, notBefore = DateTime.MinValue;
        private int quickExits, busy;
        private bool off;
        private volatile string state = "starting";

        /// <summary>"starting", "own" (started here), "external" (somebody else's SimCoach server),
        /// "taken" (another program holds the port), "nonode", "stopped" (it would not stay up), "norepo".</summary>
        public string State { get { return state; } }

        public AppServer(string dataDir, Action<string> log)
        {
            this.log = log; this.dataDir = dataDir;
            repo = AppHost.FindRepo(dataDir);
            if (repo == null) { off = true; state = "norepo"; log("app server off: app\\server.js not found above " + dataDir); return; }
            timer = new Timer(delegate { Tick(); }, null, 3000, 3000);
        }

        private void Tick()
        {
            if (off || Interlocked.Exchange(ref busy, 1) == 1) return;
            try
            {
                lock (gate)
                {
                    if (off) return;
                    if (owned != null)
                    {
                        if (owned.HasExited)
                        {
                            double ran = (DateTime.UtcNow - startedAt).TotalSeconds;
                            quickExits = ran < 20 ? quickExits + 1 : 0;
                            owned.Dispose(); owned = null;
                            notBefore = DateTime.UtcNow.AddSeconds(5);
                        }
                        else
                        {
                            if (AppHost.CodeStamp(repo) == codeStamp) { state = "own"; return; }
                            log("app server: files changed, starting it again");
                            Kill();
                        }
                    }
                    Port port = AppHost.Probe(1500);
                    if (port == Port.Ours)
                    {
                        // A server left over from before (SimHub was restarted with the app's
                        // window open) keeps the code it was started with: replace it once the
                        // app's files are newer than it is.
                        DateTime stamp = AppHost.CodeStamp(repo);
                        if (stamp == askedToQuit || !AppHost.Stale(repo)) { state = "external"; quickExits = 0; return; }
                        askedToQuit = stamp; // once per change: a server that will not go is left alone
                        log("app server: the one running has older code, replacing it");
                        if (!AppHost.Quit()) { log("app server: it did not make room"); state = "external"; return; }
                    }
                    else if (port == Port.Taken) { if (state != "taken") log("app server: port " + AppHost.PortNumber + " is used by another program"); state = "taken"; return; }
                    if (DateTime.UtcNow < notBefore) return;
                    if (quickExits >= 3)
                    {
                        off = true; state = "stopped";
                        log("app server off: it stopped three times right after starting");
                        return;
                    }
                    try
                    {
                        codeStamp = AppHost.CodeStamp(repo);
                        owned = AppHost.StartServer(repo, true, delegate(string line) { log("app server: " + line); });
                        startedAt = DateTime.UtcNow;
                        state = "own";
                        log("app server started on port " + AppHost.PortNumber);
                    }
                    catch (Exception ex)
                    {
                        off = true; state = "nonode";
                        log("app server off (node could not be started): " + ex.Message);
                    }
                }
            }
            catch (Exception ex) { log("app server: " + ex.Message); }
            finally { Interlocked.Exchange(ref busy, 0); }
        }

        private void Kill()
        {
            try { if (owned != null && !owned.HasExited) { owned.Kill(); owned.WaitForExit(3000); } } catch { }
            if (owned != null) { owned.Dispose(); owned = null; }
        }

        /// <summary>
        /// Opens the app's window, waiting a moment for a server that is still starting.
        /// Returns what went wrong, or null.
        /// </summary>
        public string OpenWindow(string route)
        {
            if (state == "nonode") return "nonode";
            if (state == "norepo" || state == "stopped" || state == "taken") return state;
            try
            {
                if (!AppHost.WaitForServer(null, 8)) return "starting";
                AppHost.OpenWindow(dataDir, route);
                return null;
            }
            catch (Exception ex) { log("app window: " + ex.Message); return "error"; }
        }

        public void Stop()
        {
            if (timer != null) { timer.Dispose(); timer = null; }
            lock (gate)
            {
                off = true;
                // With the app's window still open the server stays: it ends by itself when the
                // window is closed (see --parent in app\server.js).
                if (owned != null && AppHost.WindowOpen(dataDir)) { log("app window is open: the server stays until it is closed"); owned.Dispose(); owned = null; }
                else Kill();
            }
        }
    }
}
