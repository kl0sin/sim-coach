// Draws the SimHub page of the plugin into PNG files, so its look can be checked without SimHub.
//   PanelPreview.exe <output folder> [log file]
// Writes panel_driving.png and panel_idle.png. C# 5 syntax only.
using System;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace SimCoach
{
    internal static class PanelPreview
    {
        private static void Shot(string file, PanelState state, string logFile)
        {
            var panel = new SettingsPanel(delegate { return state; }, delegate(string route) { return null; }, delegate { }, logFile);
            panel.Refresh();
            var size = new Size(1100, 860);
            panel.Measure(size); panel.Arrange(new Rect(size)); panel.UpdateLayout();
            var bitmap = new RenderTargetBitmap((int)size.Width, (int)size.Height, 96, 96, PixelFormats.Pbgra32);
            bitmap.Render(panel);
            var png = new PngBitmapEncoder();
            png.Frames.Add(BitmapFrame.Create(bitmap));
            using (var fs = File.Create(file)) png.Save(fs);
            Console.WriteLine("written " + file);
        }

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length < 1) { Console.WriteLine("usage: PanelPreview <output folder> [log file]"); return 1; }
            Directory.CreateDirectory(args[0]);
            string log = args.Length > 1 ? args[1] : Path.Combine(args[0], "sample.log");
            if (args.Length < 2)
                File.WriteAllLines(log, new[]
                {
                    "2026-01-10 18:02:11  plugin started",
                    "2026-01-10 18:02:14  app server started on port 8377",
                    "2026-01-10 18:02:19  plan refresh: 1 plan(s) in 0.8 s",
                    "2026-01-10 18:05:40  session: AssettoCorsaEVO|Nordschleife||Porsche 992 GT3 R",
                    "2026-01-10 18:05:41  overlay guide loaded: 7 corners",
                    "2026-01-10 18:12:27  lap saved: 6:23.790"
                });

            var driving = new PanelState();
            driving.Server = "own"; driving.Recording = true; driving.Track = "Nordschleife"; driving.Car = "Porsche 992 GT3 R";
            driving.LapsSaved = 3; driving.GuideCorners = 7; driving.OverlayOn = true;
            Shot(Path.Combine(args[0], "panel_driving.png"), driving, log);

            var idle = new PanelState();
            idle.Server = "nonode";
            Shot(Path.Combine(args[0], "panel_idle.png"), idle, log);
            return 0;
        }
    }
}
