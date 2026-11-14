// SimCoach.exe: opens the app like a desktop program. Starts the server in the background if
// nothing is running it yet (with SimHub open, the plugin already is) and shows the app in a
// window of its own. A server started here ends by itself when that window is closed.
//   SimCoach.exe [route]     e.g. SimCoach.exe /overlay
// C# 5 syntax only.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace SimCoach
{
    internal static class Launcher
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int MessageBox(IntPtr owner, string text, string caption, uint type);

        private static int Fail(string text)
        {
            MessageBox(IntPtr.Zero, text, "SimCoach", 0x30);
            return 1;
        }

        [STAThread]
        private static int Main(string[] args)
        {
            string repo = AppHost.FindRepo(AppDomain.CurrentDomain.BaseDirectory);
            if (repo == null) return Fail("Nie znaleziono aplikacji SimCoach (app\\server.js) w folderach powyżej tego programu.");

            string dataDir = Path.Combine(repo, "data");
            // Without Edge or Chrome the page opens in the default browser, where nothing tells
            // us when it is closed: the server then simply stays.
            bool ownWindow = AppHost.HasAppWindow;
            Process server = null;
            string lastError = "";
            if (AppHost.Probe(1500) == Port.Free)
            {
                try { server = AppHost.StartServer(repo, ownWindow, delegate(string line) { lastError = line; }); }
                catch (Exception ex)
                {
                    return Fail("Nie udało się uruchomić Node.js. Zainstaluj go ze strony nodejs.org i spróbuj ponownie.\n\n" + ex.Message);
                }
                if (!AppHost.WaitForServer(server, 15))
                {
                    try { if (!server.HasExited) server.Kill(); } catch { }
                    return Fail("Serwer SimCoach nie wystartował." + (lastError.Length > 0 ? "\n\n" + lastError : ""));
                }
            }

            Process window;
            try { window = AppHost.OpenWindow(dataDir, args.Length > 0 ? args[0] : ""); }
            catch (Exception ex)
            {
                try { if (server != null && !server.HasExited) server.Kill(); } catch { }
                return Fail("Nie udało się otworzyć okna aplikacji.\n\n" + ex.Message);
            }
            if (window == null || server == null) return 0;

            // The server we started ends by itself once this program is gone and the window is
            // closed, so all that is left is to stay until the window is really there.
            DateTime until = DateTime.UtcNow.AddSeconds(20);
            while (DateTime.UtcNow < until && !AppHost.WindowOpen(dataDir)) Thread.Sleep(200);
            if (!AppHost.WindowOpen(dataDir))
            {
                // a browser that keeps no lock file: stay for as long as its process does
                window.WaitForExit();
                try { if (!server.HasExited) server.Kill(); } catch { }
            }
            return 0;
        }
    }
}
