// Runs the plan refresher as the plugin does (one tick a second) and shows what it logged:
// once at the start, and once more after a lap is "saved". Needs Node.js and the app next to
// the data folder. Usage: RefreshTest.exe <data dir> <log file>
using System;
using System.IO;
using System.Threading;

namespace SimCoach
{
    public static class RefreshTest
    {
        public static int Main(string[] args)
        {
            string log = args[1];
            if (File.Exists(log)) File.Delete(log);
            var refresher = new PlanRefresher(args[0], new Logger(log));
            for (int s = 0; s < 40; s++)
            {
                refresher.Tick(s < 20 ? 3 : 4); // a fourth recording appears after twenty seconds
                Thread.Sleep(1000);
            }
            refresher.Stop();
            string text = File.Exists(log) ? File.ReadAllText(log) : "";
            Console.Write(text);
            int runs = 0;
            foreach (string line in text.Split('\n')) if (line.Contains("plan refresh:")) runs++;
            Console.WriteLine(runs == 2 ? "PASSED: two refreshes" : "FAILED: " + runs + " refreshes, expected 2");
            return runs == 2 ? 0 : 1;
        }
    }
}
