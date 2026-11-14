// Builds every set of the coach's sounds without playing them and prints what they are.
// With a folder as argument, also writes them there as WAV files to listen to.
using System;
using System.Globalization;
using SimCoach;

static class SoundCheck
{
    static int Main(string[] args)
    {
        string[] names = { "", "tick", "braking point", "throttle point", "lift point" };
        for (int theme = 0; theme < SoundBank.Themes.Length - 1; theme++)
            using (var bank = new SoundBank(1.0, theme, null))
                for (int k = 1; k <= SoundBank.Kinds; k++)
                {
                    double[] d = bank.Describe(k);
                    Console.WriteLine(SoundBank.Themes[theme].PadRight(6) + names[k].PadRight(15) + (d[0] * 1000).ToString("0").PadLeft(4) + " ms  peak " + d[1].ToString("0.00", CultureInfo.InvariantCulture) + "  average " + d[2].ToString("0.000", CultureInfo.InvariantCulture));
                    if (d[0] < 0.02 || d[0] > 0.7 || d[1] < 0.5 || d[1] > 0.96 || double.IsNaN(d[2])) { Console.WriteLine("FAIL"); return 1; }
                }
        using (var quiet = new SoundBank(0.3, 1, null)) if (Math.Abs(quiet.Describe(2)[1] - 0.3 * 0.95) > 0.02) { Console.WriteLine("FAIL: volume does not scale"); return 1; }
        using (var own = new SoundBank(1.0, SoundBank.Themes.Length - 1, "no-such-folder")) if (own.Describe(2)[1] < 0.3) { Console.WriteLine("FAIL: no fallback for missing own files"); return 1; }
        Console.WriteLine("ALL PASSED");
        return 0;
    }
}
