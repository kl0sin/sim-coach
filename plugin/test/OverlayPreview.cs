// Renders the overlay in a few typical states to one PNG, so its look can be checked without
// the game. Usage: OverlayPreview.exe <out.png>
using System;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using SimCoach;

static class OverlayPreview
{
    [STAThread]
    static int Main(string[] args)
    {
        string file = args.Length > 0 ? args[0] : "overlay.png";
        var states = new[]
        {
            new CoachState { Active = true, Corner = "Z1 TIERGARTEN", ToCorner = 860, Delta = -0.42, Message = "Hamuj 8 m dalej, jednym ciągiem do Z2", MessageKind = 1 },
            new CoachState { Active = true, Corner = "Z1 TIERGARTEN", ToCorner = 128, Phase = 1, Progress = 0.42, Mark = 0.06, TargetSpeed = 93, Delta = -0.38, Message = "Hamuj 8 m dalej, jednym ciągiem do Z2", MessageKind = 1 },
            new CoachState { Active = true, Corner = "Z1 TIERGARTEN", ToCorner = 14, Phase = 1, Progress = 0.045, Mark = 0.06, TargetSpeed = 93, Delta = -0.36, Message = "Hamuj 8 m dalej, jednym ciągiem do Z2", MessageKind = 1 },
            new CoachState { Active = true, Corner = "Z18 AREMBERG", ToCorner = 0, BrakeNow = true, TargetSpeed = 105, Delta = -0.31 },
            new CoachState { Active = true, Corner = "Z18 AREMBERG", ToCorner = 128, Phase = 1, Progress = 0.42, Pressure = 100, TargetSpeed = 105, Delta = -0.30 },
            new CoachState { Active = true, Corner = "Z18 AREMBERG", ToCorner = 46, Phase = 3, Progress = 0.38, Pressure = 100, TargetSpeed = 105, Delta = -0.29 },
            new CoachState { Active = true, Corner = "Z12 HATZENBACH", ToCorner = 70, Phase = 4, Progress = 0.5, TargetSpeed = 114, Delta = -0.12 },
            new CoachState { Active = true, Corner = "Z12 HATZENBACH", ToCorner = 0, LiftNow = true, TargetSpeed = 114, Delta = -0.12 },
            new CoachState { Active = true, Corner = "Z6 HATZENBACHBOGEN", ToCorner = 90, Flat = true, Delta = -0.08, Message = "Z5 HATZENBACHBOGEN · hamulec 70%, plan 100%", MessageKind = 2 },
            new CoachState { Active = true, Corner = "Z18 AREMBERG", ToCorner = 64, Phase = 2, Progress = 0.4, TargetSpeed = 105, Delta = -0.27, Message = "Z hamulca prosto na gaz, bez toczenia", MessageKind = 1 },
            new CoachState { Active = true, Corner = "Z18 AREMBERG", ToCorner = 0, GasNow = true, TargetSpeed = 105, Delta = -0.22 },
            new CoachState { Active = true, Corner = "Z19 FUCHSRÖHRE", ToCorner = 1240, Delta = 0.17, Message = "Z18 AREMBERG · hamulec 14 m za wcześnie · gaz 12 m za późno", MessageKind = 3 },
            new CoachState { Active = true, Corner = "Z41 CARACCIOLA KARUSSELL", ToCorner = 45, Phase = 1, Progress = 0.12, TargetSpeed = 73, Delta = double.NaN, Message = "Z40 STEILSTRECKE · w punkt", MessageKind = 2 },
            new CoachState { Active = false }
        };
        // The same overlay with the inputs strip switched on: braking into a right-hander,
        // back on the throttle out of a left-hander, and off the plan's track.
        var withInputs = new[]
        {
            new CoachState { Active = true, Corner = "Z18 AREMBERG", ToCorner = 46, Phase = 3, Progress = 0.38, Pressure = 100, TargetSpeed = 105, Delta = -0.29,
                Message = "Hamuj 14 m dalej", MessageKind = 1, Brake = 78, Throttle = 0, Steer = 64 },
            new CoachState { Active = true, Corner = "Z41 CARACCIOLA KARUSSELL", ToCorner = 64, Phase = 2, Progress = 0.4, TargetSpeed = 73, Delta = 0.12,
                Message = "Z40 STEILSTRECKE · w punkt", MessageKind = 2, Brake = 0, Throttle = 46, Steer = -128 },
            new CoachState { Active = false, Throttle = 100 }
        };
        var traces = new InputTrace[withInputs.Length];
        for (int k = 0; k < traces.Length; k++)
        {
            traces[k] = new InputTrace();
            for (int i = 0; i <= 300; i++)
            {
                double t = i / 60.0, u = t / 5.0; // five seconds of driving, ending in the state shown
                double brake = k == 0 ? (u < 0.45 ? 0 : Math.Min(100, (u - 0.45) * 900) * (u > 0.8 ? 0.78 + (1 - u) : 1)) : k == 1 ? Math.Max(0, 90 - u * 260) : 0;
                double throttle = k == 0 ? (u < 0.42 ? 100 : 0) : k == 1 ? (u < 0.5 ? 0 : (u - 0.5) * 92) : 100;
                double steer = k == 0 ? (u < 0.5 ? 4 * Math.Sin(u * 20) : (u - 0.5) * 128) : k == 1 ? -128 * Math.Min(1, u * 1.6) + 6 * Math.Sin(u * 40) : 3 * Math.Sin(u * 25);
                traces[k].Add(t, throttle, brake, steer);
            }
        }

        double gap = 16, w = OverlayPainter.Width + 2 * gap;
        double h = states.Length * (OverlayPainter.Height + gap) + withInputs.Length * (OverlayPainter.HeightFor(true) + gap) + gap;
        var visual = new DrawingVisual();
        using (DrawingContext dc = visual.RenderOpen())
        {
            // a mid-grey backdrop stands in for the game picture behind the translucent panel
            dc.DrawRectangle(new SolidColorBrush(Color.FromRgb(0x5a, 0x66, 0x5c)), null, new Rect(0, 0, w, h));
            double y = gap;
            for (int i = 0; i < withInputs.Length; i++)
            {
                dc.PushTransform(new TranslateTransform(gap, y));
                OverlayPainter.Draw(dc, withInputs[i], 1.0, traces[i]);
                dc.Pop();
                y += OverlayPainter.HeightFor(true) + gap;
            }
            for (int i = 0; i < states.Length; i++)
            {
                dc.PushTransform(new TranslateTransform(gap, y));
                OverlayPainter.Draw(dc, states[i], 1.0);
                dc.Pop();
                y += OverlayPainter.Height + gap;
            }
        }
        var bmp = new RenderTargetBitmap((int)w, (int)h, 96, 96, PixelFormats.Pbgra32);
        bmp.Render(visual);
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(bmp));
        using (FileStream fs = File.Create(file)) enc.Save(fs);
        Console.WriteLine("written " + file + " " + (int)w + "x" + (int)h);
        return 0;
    }
}
