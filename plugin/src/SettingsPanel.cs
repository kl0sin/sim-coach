// The SimCoach page inside SimHub (left menu): opens the app, and shows at a glance whether the
// app's server runs, whether laps are being recorded and what the overlay is doing. Settings
// themselves live in the app; this page only leads there. Built in code, in the look of the app
// (dark timing board, DIN lettering, square corners). C# 5 syntax only.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace SimCoach
{
    /// <summary>What the page shows; the plugin fills a new one on every refresh.</summary>
    public sealed class PanelState
    {
        public string Server = "starting"; // AppServer.State
        public bool Recording;
        public string Track = "", Car = "";
        public int LapsSaved;
        public int GuideCorners = -1;
        public bool OverlayOn;
    }

    public sealed class SettingsPanel : UserControl
    {
        private static readonly Color Bg = Rgb(0x0a, 0x0a, 0x0b), Hair = Rgb(0x26, 0x26, 0x2a), Line2 = Rgb(0x3d, 0x3d, 0x43);
        private static readonly Color Ink = Rgb(0xed, 0xeb, 0xe6), Ink2 = Rgb(0xb6, 0xb4, 0xad), Muted = Rgb(0x8b, 0x89, 0x83);
        private static readonly Color Yellow = Rgb(0xff, 0xd6, 0x0a), Green = Rgb(0x19, 0x9e, 0x70), Red = Rgb(0xe6, 0x67, 0x67), Amber = Rgb(0xc9, 0x85, 0x00);
        private static readonly FontFamily Din = new FontFamily("Bahnschrift, Segoe UI");
        private static readonly FontFamily Mono = new FontFamily("Consolas, Courier New");

        private readonly Func<PanelState> read;
        private readonly Func<string, string> open;   // route -> what went wrong, or null
        private readonly Action toggleOverlay;
        private readonly string logFile;
        private readonly DispatcherTimer timer;
        private readonly Rectangle serverLamp = new Rectangle(), recLamp = new Rectangle();
        private readonly TextBlock serverText = Text("", 13, Ink), serverNote = Text("", 13, Muted);
        private readonly TextBlock recText = Text("", 13, Ink), lapsText = Text("", 13, Ink), planText = Text("", 13, Ink);
        private readonly TextBlock logText = new TextBlock(), openNote = Text("", 13, Red);
        private Button overlayOn, overlayOff;
        private bool overlayShown;

        public SettingsPanel(Func<PanelState> read, Func<string, string> open, Action toggleOverlay, string logFile)
        {
            this.read = read; this.open = open; this.toggleOverlay = toggleOverlay; this.logFile = logFile;
            Background = new SolidColorBrush(Bg);
            Foreground = new SolidColorBrush(Ink);
            FontFamily = Din;
            Content = Build();
            timer = new DispatcherTimer();
            timer.Interval = TimeSpan.FromSeconds(1);
            timer.Tick += delegate { if (IsVisible) Refresh(); };
            IsVisibleChanged += delegate { if (IsVisible) Refresh(); };
            Loaded += delegate { timer.Start(); Refresh(); };
            Unloaded += delegate { timer.Stop(); };
        }

        private static Color Rgb(byte r, byte g, byte b) { return Color.FromRgb(r, g, b); }

        private static SolidColorBrush Paint(Color c)
        {
            var b = new SolidColorBrush(c);
            b.Freeze();
            return b;
        }

        private static TextBlock Text(string text, double size, Color color)
        {
            var t = new TextBlock();
            t.Text = text; t.FontSize = size; t.Foreground = Paint(color);
            t.TextWrapping = TextWrapping.Wrap; t.VerticalAlignment = VerticalAlignment.Center;
            return t;
        }

        // The app letters its labels wide apart; WPF has no letter spacing, hair spaces stand in.
        private static string Spaced(string s)
        {
            var sb = new StringBuilder();
            for (int i = 0; i < s.Length; i++) { if (i > 0) sb.Append(' '); sb.Append(s[i]); }
            return sb.ToString();
        }

        /// <summary>The mark: the letter S as two bends of a track, cut in two like sectors on a
        /// timing screen. The same drawing is in app/public/index.html and plugin/icon.ps1.</summary>
        public static DrawingImage Mark(Color top, Color bottom)
        {
            var letter = new DrawingGroup();
            // leaning 12 degrees forward around the middle of its 64-unit box
            letter.Transform = new MatrixTransform(1, 0, -0.212557, 1, 6.8018, 0);
            letter.Children.Add(new GeometryDrawing(null, new Pen(Paint(top), 11), Geometry.Parse("M49 14.5H29.5a8.75 8.75 0 0 0 0 17.5H30")));
            letter.Children.Add(new GeometryDrawing(null, new Pen(Paint(bottom), 11), Geometry.Parse("M34 32H34.5a8.75 8.75 0 0 1 0 17.5H15")));
            var group = new DrawingGroup();
            group.Children.Add(new GeometryDrawing(Brushes.Transparent, null, new RectangleGeometry(new Rect(4, 4, 56, 56))));
            group.Children.Add(letter);
            var image = new DrawingImage(group);
            image.Freeze();
            return image;
        }

        private UIElement Build()
        {
            var page = new StackPanel();
            page.Margin = new Thickness(36, 28, 36, 36);

            // brand row
            var brand = new StackPanel();
            brand.Orientation = Orientation.Horizontal;
            var mark = new Image();
            mark.Source = Mark(Yellow, Ink); mark.Width = 26; mark.Height = 26;
            var word = Text(Spaced("SIMCOACH"), 19, Ink);
            word.FontWeight = FontWeights.Bold; word.Margin = new Thickness(12, 2, 0, 0);
            brand.Children.Add(mark); brand.Children.Add(word);
            page.Children.Add(brand);
            page.Children.Add(Rule(16, 0));

            // 01 the app
            page.Children.Add(Heading("01", "APLIKACJA", "Analiza okrążeń, plan i ustawienia nakładki."));
            var buttons = new StackPanel();
            buttons.Orientation = Orientation.Horizontal; buttons.Margin = new Thickness(0, 4, 0, 12);
            buttons.Children.Add(Key("OTWÓRZ SIMCOACH", true, delegate { Open(""); }));
            Button second = Key("USTAWIENIA NAKŁADKI", false, delegate { Open("/overlay"); });
            second.Margin = new Thickness(10, 0, 0, 0);
            buttons.Children.Add(second);
            page.Children.Add(buttons);
            openNote.Margin = new Thickness(0, 10, 0, 0); openNote.Visibility = Visibility.Collapsed;
            page.Children.Add(openNote);
            page.Children.Add(Row("SERWER", Lamp(serverLamp, serverText, serverNote)));

            // 02 driving
            page.Children.Add(Heading("02", "JAZDA", "Co wtyczka robi teraz."));
            page.Children.Add(Row("NAGRYWANIE", Lamp(recLamp, recText, null)));
            page.Children.Add(Row("OKRĄŻENIA", lapsText));
            page.Children.Add(Row("PLAN", planText));
            var seg = new StackPanel();
            seg.Orientation = Orientation.Horizontal;
            overlayOn = Segment("WIDOCZNA", delegate { SetOverlay(true); });
            overlayOff = Segment("UKRYTA", delegate { SetOverlay(false); });
            overlayOff.BorderThickness = new Thickness(0, 1, 1, 1);
            seg.Children.Add(overlayOn); seg.Children.Add(overlayOff);
            page.Children.Add(Row("NAKŁADKA W GRZE", seg));

            // 03 the log
            page.Children.Add(Heading("03", "DZIENNIK", "Ostatnie wpisy wtyczki."));
            logText.FontFamily = Mono; logText.FontSize = 12; logText.Foreground = Paint(Ink2);
            logText.TextWrapping = TextWrapping.NoWrap; logText.TextTrimming = TextTrimming.CharacterEllipsis;
            logText.LineHeight = 19;
            var logBox = new Border();
            logBox.BorderBrush = Paint(Hair); logBox.BorderThickness = new Thickness(1);
            logBox.Background = Paint(Rgb(0x10, 0x10, 0x12)); logBox.Padding = new Thickness(14, 10, 14, 10);
            logBox.Child = logText;
            page.Children.Add(logBox);

            // the page keeps to the left and stops growing at a readable width
            var frame = new Grid();
            var main = new ColumnDefinition { Width = new GridLength(1000, GridUnitType.Star) };
            main.MaxWidth = 1040;
            frame.ColumnDefinitions.Add(main);
            frame.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetColumn(page, 0);
            frame.Children.Add(page);

            var scroll = new ScrollViewer();
            scroll.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            scroll.HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;
            scroll.Content = frame;
            return scroll;
        }

        private static Border Rule(double above, double below)
        {
            var b = new Border();
            b.Height = 1; b.Background = Paint(Hair); b.Margin = new Thickness(0, above, 0, below);
            return b;
        }

        // "01  APLIKACJA ........ what it is" with a line under it, as the app's page heads
        private static UIElement Heading(string index, string title, string lead)
        {
            var grid = new Grid();
            grid.Margin = new Thickness(0, 30, 0, 0);
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var idx = Text(index, 13, Yellow);
            idx.FontWeight = FontWeights.SemiBold; idx.VerticalAlignment = VerticalAlignment.Bottom; idx.Margin = new Thickness(0, 0, 14, 5);
            var head = Text(title, 30, Ink);
            head.FontWeight = FontWeights.Bold; head.VerticalAlignment = VerticalAlignment.Bottom;
            var note = Text(lead, 13, Ink2);
            note.HorizontalAlignment = HorizontalAlignment.Right; note.VerticalAlignment = VerticalAlignment.Bottom; note.Margin = new Thickness(20, 0, 0, 6);
            Grid.SetColumn(idx, 0); Grid.SetColumn(head, 1); Grid.SetColumn(note, 2);
            grid.Children.Add(idx); grid.Children.Add(head); grid.Children.Add(note);
            var stack = new StackPanel();
            stack.Children.Add(grid);
            stack.Children.Add(Rule(8, 12));
            return stack;
        }

        // a labelled row with a line under it
        private static UIElement Row(string label, UIElement value)
        {
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(170) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.MinHeight = 38;
            var name = Text(Spaced(label), 12, Ink2);
            Grid.SetColumn(name, 0); Grid.SetColumn((FrameworkElement)value, 1);
            ((FrameworkElement)value).VerticalAlignment = VerticalAlignment.Center;
            grid.Children.Add(name); grid.Children.Add(value);
            var stack = new StackPanel();
            stack.Margin = new Thickness(0, 6, 0, 0);
            stack.Children.Add(grid);
            stack.Children.Add(Rule(6, 0));
            return stack;
        }

        // a small square lamp, the state in capitals, and a quieter note after it
        private static UIElement Lamp(Rectangle lamp, TextBlock text, TextBlock note)
        {
            var row = new StackPanel();
            row.Orientation = Orientation.Horizontal;
            lamp.Width = 9; lamp.Height = 9; lamp.Margin = new Thickness(0, 0, 10, 0); lamp.VerticalAlignment = VerticalAlignment.Center;
            text.FontWeight = FontWeights.SemiBold;
            row.Children.Add(lamp); row.Children.Add(text);
            if (note != null) { note.Margin = new Thickness(12, 0, 0, 0); row.Children.Add(note); }
            return row;
        }

        // A real button (keyboard, screen readers) that draws nothing but our own flat box.
        private static Button Flat(string label, double size, FontWeight weight, Thickness padding, Action click)
        {
            var box = new FrameworkElementFactory(typeof(Border));
            box.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(Control.BackgroundProperty));
            box.SetValue(Border.BorderBrushProperty, new TemplateBindingExtension(Control.BorderBrushProperty));
            box.SetValue(Border.BorderThicknessProperty, new TemplateBindingExtension(Control.BorderThicknessProperty));
            box.SetValue(Border.PaddingProperty, new TemplateBindingExtension(Control.PaddingProperty));
            box.AppendChild(new FrameworkElementFactory(typeof(ContentPresenter)));
            var template = new ControlTemplate(typeof(Button));
            template.VisualTree = box;

            var b = new Button();
            b.Template = template;
            var t = Text(Spaced(label), size, Ink);
            t.FontWeight = weight;
            b.Content = t;
            b.Padding = padding;
            b.BorderThickness = new Thickness(1);
            b.Cursor = Cursors.Hand;
            b.Click += delegate { click(); };
            System.Windows.Automation.AutomationProperties.SetName(b, label);
            return b;
        }

        private static Button Key(string label, bool primary, Action click)
        {
            Button b = Flat(label, 13, FontWeights.Bold, new Thickness(18, 11, 18, 11), click);
            ((TextBlock)b.Content).Foreground = Paint(primary ? Bg : Ink);
            SolidColorBrush rest = Paint(primary ? Yellow : Bg), over = Paint(primary ? Rgb(0xff, 0xe2, 0x4d) : Rgb(0x17, 0x17, 0x1a));
            b.Background = rest; b.BorderBrush = Paint(primary ? Yellow : Line2);
            b.MouseEnter += delegate { b.Background = over; };
            b.MouseLeave += delegate { b.Background = rest; };
            return b;
        }

        private static Button Segment(string label, Action click)
        {
            Button b = Flat(label, 12, FontWeights.SemiBold, new Thickness(14, 8, 14, 8), click);
            b.BorderBrush = Paint(Line2); b.Background = Paint(Bg);
            return b;
        }

        private static void Select(Button segment, bool on)
        {
            segment.Background = Paint(on ? Ink : Bg);
            ((TextBlock)segment.Content).Foreground = Paint(on ? Bg : Ink);
        }
        private void SetOverlay(bool on)
        {
            if (on == overlayShown) return;
            try { toggleOverlay(); } catch { }
            Refresh();
        }

        private void Open(string route)
        {
            openNote.Visibility = Visibility.Collapsed;
            // off the UI thread: a server that is still starting is waited for
            ThreadPool.QueueUserWorkItem(delegate
            {
                string problem;
                try { problem = open(route); } catch (Exception ex) { problem = ex.Message; }
                if (problem == null) return;
                Dispatcher.BeginInvoke(new Action(delegate
                {
                    openNote.Text = Problem(problem);
                    openNote.Visibility = Visibility.Visible;
                }));
            });
        }

        private static string Problem(string state)
        {
            if (state == "nonode") return "Nie znaleziono Node.js. Zainstaluj go ze strony nodejs.org i uruchom SimHub ponownie.";
            if (state == "taken") return "Port " + AppHost.PortNumber + " zajmuje inny program, więc aplikacja nie może wystartować.";
            if (state == "stopped") return "Serwer aplikacji nie chce wystartować. Szczegóły są w dzienniku poniżej.";
            if (state == "norepo") return "Nie znaleziono folderu aplikacji (app\\server.js).";
            if (state == "starting") return "Serwer jeszcze startuje. Spróbuj za chwilę.";
            return "Nie udało się otworzyć okna aplikacji: " + state;
        }

        /// <summary>Reads the state again and shows it (once a second while the page is visible).</summary>
        public void Refresh()
        {
            PanelState s;
            try { s = read(); } catch { return; }

            bool up = s.Server == "own" || s.Server == "external";
            serverLamp.Fill = Paint(up ? Green : s.Server == "starting" ? Amber : Red);
            serverText.Text = up ? "DZIAŁA" : s.Server == "starting" ? "STARTUJE" : "NIE DZIAŁA";
            serverNote.Text = s.Server == "own" ? "uruchomiony przez wtyczkę · localhost:" + AppHost.PortNumber
                : s.Server == "external" ? "uruchomiony osobno · localhost:" + AppHost.PortNumber
                : s.Server == "starting" ? "" : Problem(s.Server);

            recLamp.Fill = Paint(s.Recording ? Green : Muted);
            recText.Text = s.Recording ? "TRWA" + (s.Track.Length > 0 ? " · " + s.Track + (s.Car.Length > 0 ? " — " + s.Car : "") : "") : "CZEKA NA JAZDĘ";
            lapsText.Text = s.LapsSaved == 0 ? "Żadnego od uruchomienia SimHuba." : s.LapsSaved + " zapisanych od uruchomienia SimHuba.";
            planText.Text = s.GuideCorners >= 0 ? "Wczytany: podpowiedzi w " + s.GuideCorners + " zakrętach."
                : s.Recording ? "Brak planu dla tego toru i auta. Powstanie po pierwszym ważnym okrążeniu."
                : "Wczyta się po wyjeździe na tor.";
            overlayShown = s.OverlayOn;
            Select(overlayOn, s.OverlayOn); Select(overlayOff, !s.OverlayOn);
            logText.Text = Tail(12);
        }

        // the last lines of the log, without the date in front (the time stays)
        private string Tail(int count)
        {
            try
            {
                if (!File.Exists(logFile)) return "(pusty)";
                string text;
                using (var fs = new FileStream(logFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    long from = Math.Max(0, fs.Length - 8192);
                    fs.Seek(from, SeekOrigin.Begin);
                    using (var reader = new StreamReader(fs, Encoding.UTF8)) text = reader.ReadToEnd();
                    if (from > 0) { int nl = text.IndexOf('\n'); if (nl >= 0) text = text.Substring(nl + 1); }
                }
                string[] lines = text.Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
                var last = new List<string>();
                for (int i = Math.Max(0, lines.Length - count); i < lines.Length; i++)
                {
                    string line = lines[i].TrimEnd('\r');
                    last.Add(line.Length > 11 && line[4] == '-' && line[10] == ' ' ? line.Substring(11) : line);
                }
                return string.Join("\n", last.ToArray());
            }
            catch { return ""; }
        }
    }
}
