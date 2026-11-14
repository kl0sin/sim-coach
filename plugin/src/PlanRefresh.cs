// Keeps the overlay's plan current without the app being opened: once when SimHub starts and
// after every saved recording it runs "node app\cli.js refresh" in the background. That puts
// the plan on the best valid lap, judges the focus corners against the lap just driven and
// writes the guide again; the overlay picks the new guide up between laps. C# 5 syntax only.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

namespace SimCoach
{
    public sealed class PlanRefresher
    {
        private readonly string script;
        private readonly Logger log;
        private readonly List<string> lines = new List<string>();
        private Process running;
        private DateTime started, notBefore;
        private int seenLaps = -1;
        private bool wanted = true; // once at the start: laps may have been driven since the plan was last looked at
        private bool off;

        public PlanRefresher(string dataDir, Logger log)
        {
            script = Path.GetFullPath(Path.Combine(dataDir, "..", "app", "cli.js"));
            this.log = log;
            notBefore = DateTime.UtcNow.AddSeconds(8);
        }

        /// <summary>Once a second. lapsSaved: how many recordings the recorder has written so far.</summary>
        public void Tick(int lapsSaved)
        {
            if (off) return;
            if (lapsSaved != seenLaps)
            {
                if (seenLaps >= 0) { wanted = true; notBefore = DateTime.UtcNow.AddSeconds(2); } // let the file settle
                seenLaps = lapsSaved;
            }
            if (running != null)
            {
                if (!running.HasExited)
                {
                    if ((DateTime.UtcNow - started).TotalSeconds < 120) return;
                    try { running.Kill(); } catch { }
                    log.Write("plan refresh: stopped after two minutes");
                }
                else
                {
                    try { running.WaitForExit(); } catch { } // lets the last output lines arrive
                    lock (lines)
                    {
                        // what changed, and the closing line with the time it took
                        for (int i = 0; i < lines.Count; i++)
                            if (i == lines.Count - 1 || lines[i].IndexOf("(unchanged)", StringComparison.Ordinal) < 0) log.Write("plan " + lines[i]);
                        if (lines.Count == 0) log.Write("plan refresh: no answer (exit code " + running.ExitCode + ")");
                    }
                }
                running.Dispose(); running = null;
            }
            if (!wanted || DateTime.UtcNow < notBefore) return;
            wanted = false;
            if (!File.Exists(script)) { off = true; log.Write("plan refresh off: " + script + " not found"); return; }
            try
            {
                var info = new ProcessStartInfo("node", "\"" + script + "\" refresh");
                info.UseShellExecute = false; info.CreateNoWindow = true;
                info.RedirectStandardOutput = true; info.RedirectStandardError = true;
                info.WorkingDirectory = Path.GetDirectoryName(script);
                var p = new Process();
                p.StartInfo = info;
                DataReceivedEventHandler keep = delegate(object sender, DataReceivedEventArgs e)
                {
                    if (!string.IsNullOrEmpty(e.Data)) lock (lines) { if (lines.Count < 40) lines.Add(e.Data); }
                };
                p.OutputDataReceived += keep; p.ErrorDataReceived += keep;
                lock (lines) { lines.Clear(); }
                p.Start();
                p.BeginOutputReadLine(); p.BeginErrorReadLine();
                try { p.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { } // the game comes first
                running = p; started = DateTime.UtcNow;
            }
            catch (Exception ex)
            {
                // no Node.js on this machine: the plan is then refreshed when the app is opened, as before
                off = true;
                log.Write("plan refresh off (node could not be started): " + ex.Message);
            }
        }

        public void Stop()
        {
            off = true;
            try { if (running != null && !running.HasExited) running.Kill(); } catch { }
        }
    }
}
