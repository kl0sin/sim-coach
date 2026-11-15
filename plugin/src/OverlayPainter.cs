// Draws the in-game overlay from a CoachState. Kept apart from the window so the same
// drawing can be rendered to a picture by the preview tool. WPF, C# 5 syntax.
//
// The layout is made for a glance of a fraction of a second:
//   - on the left the countdown bar, as wide and tall as the room allows; its colour and its
//     length are read without looking straight at it, the word inside says what to do;
//   - on the right a column that never moves: the time against the reference lap on top, the
//     speed to carry through the corner under it, both in the largest figures on the panel;
//   - everything stays in its place from corner to corner, so the eye learns where to land.
using System;
using System.Globalization;
using System.Windows;
using System.Windows.Media;

namespace SimCoach
{
    public static class OverlayPainter
    {
        public const double Width = 640, Height = 138, InputsHeight = 60;
        /// <summary>The height of the overlay, with or without the inputs strip.</summary>
        public static double HeightFor(bool inputs) { return Height + (inputs ? InputsHeight : 0); }

        private const double CapHeight = 0.71; // capitals of this typeface, as a share of the font size
        // the two columns: the bar and its texts end at LeftEnd, the figures column starts after the divider
        private const double Pad = 20, LeftEnd = 468, Divider = 484, RightEnd = Width - Pad;

        private static readonly Brush Panel = Frozen(Color.FromArgb(236, 10, 10, 11));
        private static readonly Brush Line = Frozen(Color.FromRgb(0x3d, 0x3d, 0x43));
        private static readonly Brush Track = Frozen(Color.FromRgb(0x26, 0x26, 0x2a));
        private static readonly Brush Idle = Frozen(Color.FromRgb(0x19, 0x19, 0x1c));
        private static readonly Brush Ink = Frozen(Color.FromRgb(0xed, 0xeb, 0xe6));
        private static readonly Brush Muted = Frozen(Color.FromRgb(0x9a, 0x98, 0x92));
        private static readonly Brush Yellow = Frozen(Color.FromRgb(0xff, 0xd6, 0x0a));
        private static readonly Brush Gain = Frozen(Color.FromRgb(0x5a, 0xa0, 0xf2));
        private static readonly Brush Loss = Frozen(Color.FromRgb(0xf0, 0x70, 0x70));
        private static readonly Brush Brake = Frozen(Color.FromRgb(0xff, 0x4a, 0x2b));
        private static readonly Brush Gas = Frozen(Color.FromRgb(0x3e, 0xe6, 0xab));
        private static readonly Brush Black = Frozen(Color.FromRgb(0x0a, 0x0a, 0x0b));
        // the condensed DIN of the app; Windows falls back to Segoe UI if it is missing
        private static readonly FontFamily Family = new FontFamily("Bahnschrift, Segoe UI");
        private static readonly Typeface Regular = new Typeface(Family, FontStyles.Normal, FontWeights.Normal, FontStretches.Condensed);
        private static readonly Typeface Bold = new Typeface(Family, FontStyles.Normal, FontWeights.Bold, FontStretches.Condensed);
        private static readonly Pen GasPen = FrozenPen(Color.FromRgb(0x3e, 0xe6, 0xab), 2);
        private static readonly Pen BrakePen = FrozenPen(Color.FromRgb(0xff, 0x4a, 0x2b), 2);
        private static readonly Pen SteerPen = FrozenPen(Color.FromArgb(120, 0xed, 0xeb, 0xe6), 1);
        private static readonly Pen WheelPen = FrozenPen(Color.FromRgb(0xed, 0xeb, 0xe6), 3.5);
        private static readonly Pen SpokePen = FrozenPen(Color.FromRgb(0xed, 0xeb, 0xe6), 3);

        private static Brush Frozen(Color c) { var b = new SolidColorBrush(c); b.Freeze(); return b; }

        private static Pen FrozenPen(Color c, double width)
        {
            var p = new Pen(Frozen(c), width);
            p.LineJoin = PenLineJoin.Round;
            p.Freeze();
            return p;
        }

        private static double Clamp(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

        /// <summary>
        /// One line of text with the middle of its capitals on yMiddle (so it sits truly centred
        /// next to bars and figures). anchor: 0 = x is the left edge, 1 = the right edge,
        /// 0.5 = the centre. Returns the width drawn.
        /// </summary>
        private static double Put(DrawingContext dc, double dip, string s, double size, Brush brush, bool bold, double x, double yMiddle, double anchor, double maxWidth)
        {
            var t = new FormattedText(s, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, bold ? Bold : Regular, size, brush, dip);
            if (maxWidth > 0) { t.MaxTextWidth = maxWidth; t.MaxLineCount = 1; t.Trimming = TextTrimming.CharacterEllipsis; }
            double w = t.WidthIncludingTrailingWhitespace;
            dc.DrawText(t, new Point(x - w * anchor, yMiddle - (t.Baseline - CapHeight * size / 2)));
            return w;
        }

        /// <summary>The overlay without the inputs strip.</summary>
        public static void Draw(DrawingContext dc, CoachState st, double dip) { Draw(dc, st, dip, null); }

        /// <summary>
        /// The whole overlay. With a trace, the inputs strip is drawn under the coach's rows:
        /// what the pedals and the steering wheel are doing, now and over the last seconds.
        /// </summary>
        public static void Draw(DrawingContext dc, CoachState st, double dip, InputTrace trace)
        {
            double total = HeightFor(trace != null);
            dc.DrawRectangle(Panel, new Pen(Line, 1), new Rect(0.5, 0.5, Width - 1, total - 1));
            Coach(dc, st, dip, total);
            if (trace != null) Inputs(dc, st, dip, trace);
        }

        private static void Coach(DrawingContext dc, CoachState st, double dip, double total)
        {
            const double H = Height;
            if (st == null || !st.Active) { Put(dc, dip, "SIMCOACH · POZA TOREM Z PLANU", 18, Muted, false, Pad, H / 2, 0, 0); return; }

            bool flash = st.BrakeNow || st.GasNow || st.LiftNow;
            // one colour per thing to do: yellow braking point ahead, red braking, white lift, green throttle
            Brush doing = st.BrakeNow || st.Phase == 3 ? Brake : st.GasNow || st.Phase == 2 ? Gas : st.LiftNow || st.Phase == 4 ? Ink : st.Phase == 1 ? Yellow : null;
            dc.DrawRectangle(doing ?? Line, null, new Rect(0, 0, 7, total));
            bool counting = st.Phase != 0;

            // ---- right: the figures, always in the same two cells ----
            const double cut = 50; // where the column is split: time above, speed below
            dc.DrawRectangle(Line, null, new Rect(Divider, 0, 1, H));
            dc.DrawRectangle(Line, null, new Rect(Divider, cut, Width - Divider, 1));
            if (double.IsNaN(st.Delta)) Put(dc, dip, "BEZ POMIARU", 13, Muted, false, RightEnd, cut / 2 + 1, 1, 0);
            else Put(dc, dip, CoachEngine.Signed(st.Delta, "0.00"), 36, Math.Abs(st.Delta) < 0.005 ? Ink : st.Delta < 0 ? Gain : Loss, true, RightEnd, cut / 2 + 1, 1, 0);
            Put(dc, dip, "CEL KM/H", 12, Muted, false, Divider + 14, cut + 15, 0, 0);
            if (!double.IsNaN(st.TargetSpeed))
                Put(dc, dip, Math.Round(st.TargetSpeed).ToString(CultureInfo.InvariantCulture), 62, Ink, true, RightEnd, cut + 54, 1, 0);
            else Put(dc, dip, "—", 40, Line, true, RightEnd, cut + 54, 1, 0);

            // ---- left, row 1: the corner, and how far the point being counted down to is ----
            const double y1 = 27;
            double metresW = 0;
            if (!flash && !double.IsNaN(st.ToCorner) && st.ToCorner > 0)
            {
                // the last metres to the throttle point count one by one; a braking point comes up too fast for that
                double unit = (st.Phase == 2 || st.Phase == 3) && st.ToCorner < 30 ? 1 : 5;
                string metres = st.ToCorner >= 1000
                    ? (st.ToCorner / 1000).ToString("0.0", CultureInfo.InvariantCulture).Replace('.', ',') + " KM"
                    : (Math.Round(st.ToCorner / unit) * unit).ToString(CultureInfo.InvariantCulture) + " M";
                metresW = Put(dc, dip, metres, counting ? 34 : 24, counting ? Ink : Muted, counting, LeftEnd, y1, 1, 0) + 14;
            }
            Put(dc, dip, st.Corner.Length > 0 ? st.Corner : "—", 24, Ink, true, Pad, y1, 0, LeftEnd - Pad - metresW);

            // ---- left, row 2: the bar. It is full at the start of the countdown and runs out at
            // the point; the word inside says which point it is, and how hard to brake. ----
            const double barY = 48, barH = 44, y2 = barY + barH / 2, barW = LeftEnd - Pad;
            Rect bar = new Rect(Pad, barY, barW, barH);
            // (between corners the empty bar keeps its place, but steps back)
            dc.DrawRectangle(flash || counting ? Track : Idle, null, bar);
            if (flash)
            {
                dc.DrawRectangle(doing, null, bar);
                Put(dc, dip, st.BrakeNow ? "HAMUJ" : st.LiftNow ? "ODPUŚĆ GAZ" : "GAZ", 32, Black, true, Pad + barW / 2, y2, 0.5, 0);
            }
            else if (counting)
            {
                Rect fill = new Rect(Pad, barY, Math.Max(3, barW * st.Progress), barH);
                dc.DrawRectangle(doing, null, fill);
                string pressure = st.Pressure > 0 ? " " + Math.Round(st.Pressure).ToString(CultureInfo.InvariantCulture) + "%" : "";
                string word = st.Phase == 1 ? "HAMULEC" + pressure : st.Phase == 3 ? "TRZYMAJ" + pressure : st.Phase == 4 ? "ODPUŚĆ GAZ" : "GAZ";
                // At the end the colour runs out towards, next to the metres above it and the
                // figures beside it: light on the dark track, dark while the colour still covers it.
                Put(dc, dip, word, 24, Ink, true, LeftEnd - 14, y2, 1, 0);
                dc.PushClip(new RectangleGeometry(fill));
                Put(dc, dip, word, 24, Black, true, LeftEnd - 14, y2, 1, 0);
                dc.Pop();
                // where the reference lap braked: the plan asks to hold on past this notch
                if (!double.IsNaN(st.Mark))
                {
                    double mx = Math.Round(Pad + barW * st.Mark);
                    dc.DrawRectangle(st.Progress > st.Mark ? Black : Muted, null, new Rect(mx - 1.5, barY, 3, barH));
                    dc.DrawRectangle(Ink, null, new Rect(mx - 1.5, barY - 6, 3, 5));
                }
            }
            else if (st.Flat) Put(dc, dip, "PEŁNY GAZ", 24, Gas, true, LeftEnd - 14, y2, 1, 0); // nothing to count down to: this one is flat out

            // ---- left, row 3: the coach's note for this corner, or the verdict on the last one ----
            const double y3 = 116;
            if (st.Message.Length == 0) return;
            double x = Pad;
            if (st.MessageKind == 1)
            {
                var tag = new FormattedText("COACH", CultureInfo.InvariantCulture, FlowDirection.LeftToRight, Bold, 13, Black, dip);
                dc.DrawRectangle(Yellow, null, new Rect(x, y3 - 11, tag.WidthIncludingTrailingWhitespace + 14, 22));
                Put(dc, dip, "COACH", 13, Black, true, x + 7, y3, 0, 0);
                x += tag.WidthIncludingTrailingWhitespace + 24;
            }
            else if (st.MessageKind >= 2)
            {
                dc.DrawRectangle(st.MessageKind == 2 ? Gain : Loss, null, new Rect(x, y3 - 6, 12, 12));
                x += 22;
            }
            Put(dc, dip, st.Message.ToUpperInvariant(), 20, Ink, false, x, y3, 0, LeftEnd - x);
        }

        // The inputs strip: a trace of throttle, brake and steering over the last seconds (the
        // newest at the right edge), the two pedals as bars with their percentages, and, in the
        // figures column, the steering wheel turned as far as the real one, with its angle.
        private static void Inputs(DrawingContext dc, CoachState st, double dip, InputTrace trace)
        {
            const double top = Height, mid = Height + InputsHeight / 2, gh = 40, bw = 18, gap = 5, numbers = 44;
            dc.DrawRectangle(Line, null, new Rect(Pad, top, Width - 2 * Pad, 1));
            dc.DrawRectangle(Line, null, new Rect(Divider, top, 1, InputsHeight));
            double throttle = st == null ? 0 : Clamp(st.Throttle / 100, 0, 1), brake = st == null ? 0 : Clamp(st.Brake / 100, 0, 1), steer = st == null ? 0 : st.Steer;

            // the pedals now, at the end of the trace they continue: bars, then the figures in the same colours
            double bx = LeftEnd - numbers - 2 * bw - gap;
            Rect graph = new Rect(Pad, mid - gh / 2, bx - 12 - Pad, gh);
            dc.DrawRectangle(Track, null, new Rect(bx, graph.Y, bw, gh));
            dc.DrawRectangle(Brake, null, new Rect(bx, graph.Bottom - gh * brake, bw, gh * brake));
            dc.DrawRectangle(Track, null, new Rect(bx + bw + gap, graph.Y, bw, gh));
            dc.DrawRectangle(Gas, null, new Rect(bx + bw + gap, graph.Bottom - gh * throttle, bw, gh * throttle));
            Put(dc, dip, Math.Round(brake * 100).ToString(CultureInfo.InvariantCulture), 20, brake > 0.005 ? Brake : Muted, true, LeftEnd, mid - 10.5, 1, 0);
            Put(dc, dip, Math.Round(throttle * 100).ToString(CultureInfo.InvariantCulture), 20, throttle > 0.005 ? Gas : Muted, true, LeftEnd, mid + 10.5, 1, 0);

            // the trace
            dc.DrawRectangle(Track, null, graph);
            dc.DrawRectangle(Line, null, new Rect(graph.X, mid, graph.Width, 1));
            dc.PushClip(new RectangleGeometry(graph));
            Series(dc, trace, graph, 2, SteerPen);
            Series(dc, trace, graph, 0, GasPen);
            Series(dc, trace, graph, 1, BrakePen);
            dc.Pop();

            // the steering wheel
            const double r = 19;
            var c = new Point(Divider + 14 + r + 2, mid);
            dc.PushTransform(new RotateTransform(steer, c.X, c.Y));
            dc.DrawEllipse(null, WheelPen, c, r, r);
            dc.DrawLine(SpokePen, new Point(c.X - r, c.Y), new Point(c.X + r, c.Y));
            dc.DrawLine(SpokePen, new Point(c.X, c.Y), new Point(c.X, c.Y + r));
            dc.DrawRectangle(Yellow, null, new Rect(c.X - 3, c.Y - r - 3, 6, 8)); // the stripe at twelve o'clock
            dc.Pop();
            double deg = Math.Round(Math.Abs(steer));
            double w = Put(dc, dip, deg.ToString(CultureInfo.InvariantCulture) + "°", 26, deg >= 1 ? Ink : Muted, true, RightEnd, mid, 1, 0);
            if (deg >= 1) Put(dc, dip, steer < 0 ? "L" : "P", 13, Muted, true, RightEnd - w - 5, mid, 1, 0);
        }

        // One line of the trace. what: 0 throttle, 1 brake (0 at the bottom, 100 % at the top),
        // 2 steering (straight ahead on the middle line, half a turn either way fills the height).
        private static void Series(DrawingContext dc, InputTrace trace, Rect box, int what, Pen pen)
        {
            int n = trace.Count;
            if (n < 2) return;
            double newest = trace.Time(n - 1);
            var g = new StreamGeometry();
            using (StreamGeometryContext ctx = g.Open())
            {
                bool begun = false;
                for (int i = 0; i < n; i++)
                {
                    double age = newest - trace.Time(i);
                    if (age > InputTrace.Seconds) continue;
                    double v = what == 2 ? 0.5 + Clamp(trace.Steer(i) / 360, -0.5, 0.5) : Clamp((what == 0 ? trace.Throttle(i) : trace.Brake(i)) / 100, 0, 1);
                    // (a pedal at rest or flat out stays a visible line inside the box)
                    var p = new Point(box.Right - age / InputTrace.Seconds * box.Width, box.Bottom - 1 - v * (box.Height - 2));
                    if (!begun) { ctx.BeginFigure(p, false, false); begun = true; }
                    else ctx.LineTo(p, true, true);
                }
            }
            g.Freeze();
            dc.DrawGeometry(null, pen, g);
        }
    }

    /// <summary>
    /// The pedals and the steering angle of the last few seconds, for the trace in the overlay.
    /// A ring: adding the newest pushes the oldest out. Used from one thread only.
    /// </summary>
    public sealed class InputTrace
    {
        public const double Seconds = 5.0;
        private const int Size = 400; // five seconds at 60 a second, with room to spare
        private readonly double[] time = new double[Size], throttle = new double[Size], brake = new double[Size], steer = new double[Size];
        private int start, count;

        public int Count { get { return count; } }
        public double Time(int i) { return time[(start + i) % Size]; }
        public double Throttle(int i) { return throttle[(start + i) % Size]; }
        public double Brake(int i) { return brake[(start + i) % Size]; }
        public double Steer(int i) { return steer[(start + i) % Size]; }

        public void Add(double t, double throttleNow, double brakeNow, double steerNow)
        {
            int at = (start + count) % Size;
            if (count == Size) { at = start; start = (start + 1) % Size; } else count++;
            time[at] = t; throttle[at] = throttleNow; brake[at] = brakeNow; steer[at] = steerNow;
        }

        public void Clear() { start = 0; count = 0; }
    }
}
