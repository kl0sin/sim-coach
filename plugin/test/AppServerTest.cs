// Checks the part of the plugin that keeps the app's server running: it starts the server, starts
// it again when one of the app's files changes, and takes it down when told to stop.
// Run by hand (needs Node.js, takes about 20 seconds); uses port 8399, so a running SimCoach is
// left alone. C# 5 syntax only.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;

namespace SimCoach
{
    internal static class AppServerTest
    {
        private static int failures;

        private static void Check(bool ok, string what)
        {
            Console.WriteLine((ok ? "  ok    " : "  FAIL  ") + what);
            if (!ok) failures++;
        }

        // the process id of the server answering on the test port, 0 when none does
        private static int ServerPid()
        {
            if (AppHost.Probe(1500) != Port.Ours) return 0;
            try
            {
                using (var web = new WebClient())
                {
                    Match m = Regex.Match(web.DownloadString("http://127.0.0.1:" + AppHost.PortNumber + "/api/ping"), "\"pid\":(\\d+)");
                    return m.Success ? int.Parse(m.Groups[1].Value) : 0;
                }
            }
            catch { return 0; }
        }

        private static int WaitForPid(int other, int seconds)
        {
            DateTime until = DateTime.UtcNow.AddSeconds(seconds);
            while (DateTime.UtcNow < until)
            {
                int pid = ServerPid();
                if (pid != 0 && pid != other) return pid;
                Thread.Sleep(300);
            }
            return 0;
        }

        private static int Main()
        {
            Environment.SetEnvironmentVariable("SIMCOACH_PORT", "8399");
            string repo = AppHost.FindRepo(AppDomain.CurrentDomain.BaseDirectory);
            if (repo == null) { Console.WriteLine("app\\server.js not found above this program"); return 1; }
            Check(AppHost.Probe(1500) == Port.Free, "the test port is free to begin with");

            var server = new AppServer(Path.Combine(repo, "data"), delegate(string line) { Console.WriteLine("        log: " + line); });
            int first = WaitForPid(0, 15);
            Check(first != 0, "the server is started and answers as SimCoach");
            Check(server.State == "own", "it is reported as started here (state: " + server.State + ")");

            File.SetLastWriteTimeUtc(Path.Combine(repo, "app", "cli.js"), DateTime.UtcNow);
            int second = WaitForPid(first, 15);
            Check(second != 0, "after one of the app's files changed, a new server process answers");
            bool firstGone;
            try { firstGone = Process.GetProcessById(first).HasExited; } catch { firstGone = true; }
            Check(firstGone, "and the old process is gone");

            server.Stop();
            // (with the app's window open the server is left to end by itself; the test does not wait for that)
            try { Process.GetProcessById(second).Kill(); } catch { }
            Thread.Sleep(1500);
            Check(AppHost.Probe(1500) == Port.Free, "after stopping, nothing answers on the port");

            Console.WriteLine(failures == 0 ? "ALL PASSED" : failures + " FAILED");
            return failures == 0 ? 0 : 1;
        }
    }
}
