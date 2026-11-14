// AC Evo fields that SimHub's normalized data does not carry. Isolated in its own
// non-inlined method: if a SimHub update renames a field, the failure surfaces as an
// exception at the call site instead of breaking the whole plugin.
using System.Runtime.CompilerServices;
using System.Text;
using ACSharedMemory.ACEVO.MMFModels;
using ACSharedMemory.ACEVO.Reader;

namespace SimCoach
{
    internal static class EvoRaw
    {
        public const string TypeName = "ACSharedMemory.ACEVO.Reader.ACEVORawData";

        [MethodImpl(MethodImplOptions.NoInlining)]
        /// <returns>false when the car is not on track (garage / loading: no tyre contact data).</returns>
        public static bool Fill(object raw, ref Sample s, SessionInfo info)
        {
            ACEVORawData r = (ACEVORawData)raw;
            SPageFilePhysics p = r.Physics;
            SPageFileGraphicEvo g = r.Graphics;

            s.Steer = g.steer_degrees;
            s.TyresOut = p.numberOfTyresOut;
            s.Valid = g.is_valid_lap;
            if (s.Pos <= 0.0 && g.npos > 0.0f) s.Pos = g.npos;

            s.SaFL = At(p.slipAngle, 0); s.SaFR = At(p.slipAngle, 1);
            s.SaRL = At(p.slipAngle, 2); s.SaRR = At(p.slipAngle, 3);
            s.WsFL = At(p.wheelSlip, 0); s.WsFR = At(p.wheelSlip, 1);
            s.WsRL = At(p.wheelSlip, 2); s.WsRR = At(p.wheelSlip, 3);

            // SimHub publishes the last lap time only when its own lap detection fires, which in
            // multiplayer happens late or at the wrong place; the game's value is immediate.
            info.RawLastLap = g.last_laptime_ms > 0 ? g.last_laptime_ms / 1000.0 : 0.0;
            s.Kerb = p.kerbVibration;
            s.Heading = p.heading;
            Float3[] cp = p.tyreContactPoint.Values;
            if (cp != null && cp.Length >= 4)
            {
                s.CpFLx = At(cp[0].Values, 0); s.CpFLy = At(cp[0].Values, 1); s.CpFLz = At(cp[0].Values, 2);
                s.CpFRx = At(cp[1].Values, 0); s.CpFRy = At(cp[1].Values, 1); s.CpFRz = At(cp[1].Values, 2);
                s.CpRLx = At(cp[2].Values, 0); s.CpRLy = At(cp[2].Values, 1); s.CpRLz = At(cp[2].Values, 2);
                s.CpRRx = At(cp[3].Values, 0); s.CpRRy = At(cp[3].Values, 1); s.CpRRz = At(cp[3].Values, 2);
            }
            bool onTrack = s.CpFLx != 0.0 || s.CpFLz != 0.0 || s.CpRRx != 0.0 || s.CpRRz != 0.0;
            // SimHub does not provide car coordinates for AC Evo: use the centre of the four tyres.
            if (onTrack && s.X == 0.0 && s.Z == 0.0)
            {
                s.X = (s.CpFLx + s.CpFRx + s.CpRLx + s.CpRRx) / 4.0;
                s.Y = (s.CpFLy + s.CpFRy + s.CpRLy + s.CpRRy) / 4.0;
                s.Z = (s.CpFLz + s.CpFRz + s.CpRLz + s.CpRRz) / 4.0;
            }

            if (info.SmVersion.Length == 0)
            {
                SPageFileStaticEvo st = r.StaticInfo;
                info.SmVersion = Text(st.sm_version);
                info.GameVersion = Text(st.ac_evo_version);
            }
            return onTrack;
        }

        private static double At(float[] values, int index)
        {
            return values != null && values.Length > index ? values[index] : 0.0;
        }

        private static string Text(byte[] bytes)
        {
            if (bytes == null) return "";
            int n = 0;
            while (n < bytes.Length && bytes[n] != 0) n++;
            return Encoding.UTF8.GetString(bytes, 0, n);
        }
    }
}
