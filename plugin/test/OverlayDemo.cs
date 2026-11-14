// Shows the real overlay window on the desktop, fed by a recorded lap, without SimHub or the
// game: the same CoachRunner the plugin uses. Usage:
//   OverlayDemo.exe <dataDir> <seconds> <guide.txt> <lap.csv> [more.csv ...]
using System;
using System.IO;
using System.Threading;
using SimCoach;

static class OverlayDemo
{
    static int Main(string[] args)
    {
        if (args.Length < 4) { Console.WriteLine("usage: OverlayDemo <dataDir> <seconds> <guide> <csv>..."); return 2; }
        string dataDir = args[0];
        int seconds = int.Parse(args[1]);
        Directory.CreateDirectory(dataDir);
        string logFile = Path.Combine(dataDir, "overlay-demo.log");
        File.Delete(logFile);
        var runner = new CoachRunner(dataDir, new Logger(logFile));
        File.WriteAllLines(Path.Combine(dataDir, "overlay.demo.txt"), new ArraySegment<string>(args, 2, args.Length - 2));
        string seen = "";
        for (int i = 0; i < seconds; i++)
        {
            runner.Tick();
            Thread.Sleep(1000);
            CoachState s = runner.Last;
            if (s.Active) seen = s.Corner + " | to braking point " + (double.IsNaN(s.ToCorner) ? "-" : s.ToCorner.ToString("0")) + " m | delta " + (double.IsNaN(s.Delta) ? "-" : s.Delta.ToString("0.00"));
        }
        File.Delete(Path.Combine(dataDir, "overlay.demo.txt"));
        runner.Tick();
        Thread.Sleep(600);
        runner.Dispose();
        Console.WriteLine("last state: " + seen);
        Console.WriteLine(File.ReadAllText(logFile));
        return 0;
    }
}
