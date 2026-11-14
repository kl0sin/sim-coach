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
        double gap = 16, w = OverlayPainter.Width + 2 * gap, h = states.Length * (OverlayPainter.Height + gap) + gap;
        var visual = new DrawingVisual();
        using (DrawingContext dc = visual.RenderOpen())
        {
            // a mid-grey backdrop stands in for the game picture behind the translucent panel
            dc.DrawRectangle(new SolidColorBrush(Color.FromRgb(0x5a, 0x66, 0x5c)), null, new Rect(0, 0, w, h));
            for (int i = 0; i < states.Length; i++)
            {
                dc.PushTransform(new TranslateTransform(gap, gap + i * (OverlayPainter.Height + gap)));
                OverlayPainter.Draw(dc, states[i], 1.0);
                dc.Pop();
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
