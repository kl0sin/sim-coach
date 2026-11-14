// Draws the in-game overlay from a CoachState. Kept apart from the window so the same
// drawing can be rendered to a picture by the preview tool. WPF, C# 5 syntax.
using System;
using System.Globalization;
using System.Windows;
using System.Windows.Media;

namespace SimCoach
{
    public static class OverlayPainter
    {
        public const double Width = 640, Height = 138;
        private const double CapHeight = 0.71; // capitals of this typeface, as a share of the font size

        private static readonly Brush Panel = Frozen(Color.FromArgb(232, 10, 10, 11));
        private static readonly Brush Line = Frozen(Color.FromRgb(0x3d, 0x3d, 0x43));
        private static readonly Brush Track = Frozen(Color.FromRgb(0x26, 0x26, 0x2a));
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

        private static Brush Frozen(Color c) { var b = new SolidColorBrush(c); b.Freeze(); return b; }

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

        public static void Draw(DrawingContext dc, CoachState st, double dip)
        {
            const double W = Width, H = Height, pad = 20;
            dc.DrawRectangle(Panel, new Pen(Line, 1), new Rect(0.5, 0.5, W - 1, H - 1));
            if (st == null || !st.Active) { Put(dc, dip, "SIMCOACH · POZA TOREM Z PLANU", 16, Muted, false, pad, H / 2, 0, 0); return; }

            bool flash = st.BrakeNow || st.GasNow || st.LiftNow;
            // one colour per thing to do: yellow braking point ahead, red braking, white lift, green throttle
            Brush doing = st.BrakeNow || st.Phase == 3 ? Brake : st.GasNow || st.Phase == 2 ? Gas : st.LiftNow || st.Phase == 4 ? Ink : st.Phase == 1 ? Yellow : null;
            dc.DrawRectangle(doing ?? Line, null, new Rect(0, 0, 5, H));

            // row 1: the corner, and the time against the reference lap
            const double y1 = 30;
            Put(dc, dip, st.Corner.Length > 0 ? st.Corner : "—", 26, Ink, true, pad, y1, 0, 380);
            if (double.IsNaN(st.Delta)) Put(dc, dip, "BEZ POMIARU", 13, Muted, false, W - pad, y1, 1, 0);
            else
            {
                double w = Put(dc, dip, CoachEngine.Signed(st.Delta, "0.00"), 34, Math.Abs(st.Delta) < 0.005 ? Ink : st.Delta < 0 ? Gain : Loss, true, W - pad, y1, 1, 0);
                Put(dc, dip, "DO ODNIESIENIA", 13, Muted, false, W - pad - w - 12, y1, 1, 0);
            }

            // row 2: the way to the braking point, then to the throttle point, as a bar that
            // runs out at the point. The word at its end says which of the two it is.
            const double y2 = 73, barX = pad, barW = 330, barH = 26;
            Rect bar = new Rect(barX, y2 - barH / 2, barW, barH);
            dc.DrawRectangle(Track, null, bar);
            bool counting = st.Phase != 0;
            if (flash)
            {
                dc.DrawRectangle(doing, null, bar);
                Put(dc, dip, st.BrakeNow ? "HAMUJ" : st.LiftNow ? "ODPUŚĆ GAZ" : "GAZ", 22, Black, true, barX + barW / 2, y2, 0.5, 0);
            }
            else if (counting)
            {
                Rect fill = new Rect(barX, bar.Y, Math.Max(2, barW * st.Progress), barH);
                dc.DrawRectangle(doing, null, fill);
                // the word sits on the dark track, and turns dark where the fill still covers it;
                // with it, how hard to press: the plan's peak pedal pressure
                string pressure = st.Pressure > 0 ? " " + Math.Round(st.Pressure).ToString(CultureInfo.InvariantCulture) + "%" : "";
                string word = st.Phase == 1 ? "HAMULEC" + pressure : st.Phase == 3 ? "TRZYMAJ" + pressure : st.Phase == 4 ? "ODPUŚĆ GAZ" : "GAZ";
                Put(dc, dip, word, 13, Muted, true, barX + barW - 9, y2, 1, 0);
                dc.PushClip(new RectangleGeometry(fill));
                Put(dc, dip, word, 13, Black, true, barX + barW - 9, y2, 1, 0);
                dc.Pop();
                // where the reference lap braked: the plan asks to hold on past this notch
                if (!double.IsNaN(st.Mark))
                {
                    double mx = Math.Round(barX + barW * st.Mark);
                    dc.DrawRectangle(st.Progress > st.Mark ? Black : Muted, null, new Rect(mx - 1, bar.Y, 2, barH));
                    dc.DrawRectangle(Ink, null, new Rect(mx - 1, bar.Y - 5, 2, 4));
                }
            }

            else if (st.Flat) Put(dc, dip, "PEŁNY GAZ", 13, Gas, true, barX + 10, y2, 0, 0); // nothing to count down to: this one is flat out

            if (!flash && !double.IsNaN(st.ToCorner) && st.ToCorner > 0)
            {
                // the last metres to the throttle point count one by one; a braking point comes up too fast for that
                double unit = (st.Phase == 2 || st.Phase == 3) && st.ToCorner < 30 ? 1 : 5;
                string metres = st.ToCorner >= 1000
                    ? (st.ToCorner / 1000).ToString("0.0", CultureInfo.InvariantCulture).Replace('.', ',') + " KM"
                    : (Math.Round(st.ToCorner / unit) * unit).ToString(CultureInfo.InvariantCulture) + " M";
                Put(dc, dip, metres, counting ? 32 : 22, counting ? Ink : Muted, counting, barX + barW + 16, y2, 0, 0);
            }
            if (!double.IsNaN(st.TargetSpeed))
            {
                double w = Put(dc, dip, Math.Round(st.TargetSpeed).ToString(CultureInfo.InvariantCulture), 32, Ink, true, W - pad, y2, 1, 0);
                Put(dc, dip, "CEL KM/H", 13, Muted, false, W - pad - w - 10, y2, 1, 0);
            }

            // row 3: the coach's note for this corner, or the verdict on the last one
            const double y3 = 115;
            dc.DrawRectangle(Line, null, new Rect(pad, 94, W - 2 * pad, 1));
            if (st.Message.Length == 0) return;
            double x = pad;
            if (st.MessageKind == 1)
            {
                var tag = new FormattedText("COACH", CultureInfo.InvariantCulture, FlowDirection.LeftToRight, Bold, 13, Black, dip);
                dc.DrawRectangle(Yellow, null, new Rect(x, y3 - 10, tag.WidthIncludingTrailingWhitespace + 14, 20));
                Put(dc, dip, "COACH", 13, Black, true, x + 7, y3, 0, 0);
                x += tag.WidthIncludingTrailingWhitespace + 24;
            }
            else if (st.MessageKind >= 2)
            {
                dc.DrawRectangle(st.MessageKind == 2 ? Gain : Loss, null, new Rect(x, y3 - 5, 10, 10));
                x += 20;
            }
            Put(dc, dip, st.Message.ToUpperInvariant(), 18, Ink, false, x, y3, 0, W - pad - x);
        }
    }
}
