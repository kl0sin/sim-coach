// Turns the car's position, speed and pedals into what the overlay shows and sounds:
// distance to the planned braking point (or the point to lift at), how hard to brake and
// until where, then the throttle point, time against the reference lap, and a verdict after
// each corner. The plan is the target plan from the app, not a replay of one lap.
// Pure arithmetic on the guide; no SimHub types, so recorded laps can be replayed through it.
using System;
using System.Collections.Generic;
using System.Globalization;

namespace SimCoach
{
    /// <summary>What the overlay draws at one moment.</summary>
    public sealed class CoachState
    {
        public bool Active;                       // on the guide's track
        public bool OnLap;                        // between the start line and the finish line of a timed lap (or just past the finish, while its result shows)
        public string Corner = "";                // "Z18 AREMBERG": the corner being approached or driven
        public double ToCorner = double.NaN;      // metres to the point the bar counts down to; NaN: none ahead
        // what the bar counts down to: 0 nothing, 1 the braking point, 2 the throttle point,
        // 3 the point to release the brake at (while braking), 4 the point to lift the throttle at
        public int Phase;
        public bool Countdown { get { return Phase == 1; } }
        public double Progress;                   // 1 at the start of the countdown, 0 at the point
        public double Mark = double.NaN;          // on the braking countdown: where the reference lap braked, as a share of the bar
        public double Pressure;                   // brake pedal % to aim for in this corner; 0: not given
        public bool Flat;                         // this corner is taken flat out
        public bool BrakeNow;                     // just passed the braking point without braking
        public bool LiftNow;                      // just passed the lift point still on full throttle
        public bool GasNow;                       // just passed the throttle point still off the throttle
        public double TargetSpeed = double.NaN;   // km/h to carry at the slowest point
        public double Delta = double.NaN;         // seconds against the reference lap (+ = behind); NaN: not on a timed lap
        public string Message = "";
        public int MessageKind;                   // 0 neutral, 1 coach's cue, 2 as planned or better, 3 worse than plan
        public int Sound;                         // to play on this frame: 0 nothing, 1 tick (braking point coming), 2 braking point, 3 throttle point, 4 lift point
        public double S, Speed;
        // What the driver is doing right now, for the inputs strip of the overlay: pedals in
        // percent, steering wheel angle in degrees (to the right is positive).
        public double Throttle, Brake, Steer;
        public CoachState Clone() { return (CoachState)MemberwiseClone(); }
    }

    public sealed class CoachEngine
    {
        private const double CountdownSeconds = 5.0;  // the bar appears this long before the braking point
        private const double VerdictSeconds = 4.0;
        private const double FlashSeconds = 0.8;
        private const double FlashGrace = 0.2;        // seconds past a point before "brake now" / "throttle now" appears
        private const double BrakeOn = 8.0;           // brake pedal % that counts as braking
        private const double ThrottleOn = 10.0;       // throttle % that counts as back on it
        private const double ThrottleHold = 8.0;      // metres it has to stay there: a touch of the pedal is not being back on it
        private const double FullThrottle = 90.0;     // below this the driver has lifted
        private const double OnPoint = 4.0;           // metres: braking within this of the plan counts as on it
        private const double GasOnPoint = 10.0;       // the same for the throttle point and the lift point
        private const double SpeedOnPoint = 3.0;      // km/h at the slowest point
        private const double TickGap = 0.45;          // seconds between the two ticks and the tone: tick, tick, braking point
        private const double SoundLead = 0.08;        // seconds a tone is started ahead of its point, for the time it takes to sound

        private readonly Guide g;
        private readonly CoachState st = new CoachState();
        private int hint = -1, target = -1, done;     // done: corners before this one are finished with, even if the car is still inside the last of them
        private bool havePrev;
        private double prevS, lapStart = double.NaN;
        // what the driver did at the target corner
        private double brakeAt = double.NaN, slowest = double.MaxValue, window, passedAt, lastOnset = double.NaN;
        private double gasWindow, gasPassedAt, pickupAt = double.NaN, gasFrom = double.NaN, gasTop, slowestNext = double.MaxValue;
        private double releaseWindow, liftAt = double.NaN, floor = double.MaxValue, floorAt;
        // the hardest application of the brake in this corner: that one is "the braking", a dab before it is not
        private double appOn, appPeak, appLast = double.NaN, mainOn = double.NaN, mainPeak;
        private bool passed, braking, brakeSeen, lifted, gasPassed, gasLifted, fullSeen, liftReal;
        private bool tick1, tick2, toned, gasToned;
        private string verdict = "";
        private int verdictKind;
        private double verdictUntil, resultUntil;

        public CoachEngine(Guide guide) { g = guide; }

        /// <summary>Takes over from the engine of an earlier version of the same plan (it was rewritten
        /// while driving): the lap being timed carries on instead of starting from nothing.</summary>
        public void Adopt(CoachEngine previous)
        {
            if (previous == null || Math.Abs(previous.g.Length - g.Length) > 1.0) return;
            hint = previous.hint; havePrev = previous.havePrev; prevS = previous.prevS; lapStart = previous.lapStart;
            lastOnset = previous.lastOnset; braking = previous.braking;
        }
        public Guide Guide { get { return g; } }

        /// <param name="now">monotonic clock, seconds</param>
        /// <param name="speed">km/h</param>
        /// <param name="brake">0..100</param>
        /// <param name="throttle">0..100</param>
        public CoachState Update(double now, double x, double z, double speed, double brake, double throttle)
        {
            double s, off;
            hint = g.Locate(x, z, hint, out s, out off);
            st.Sound = 0;
            if (off > 60.0) // not on this track's road (car park, another layout)
            {
                st.Active = false; havePrev = false; hint = -1; target = -1; done = 0; lapStart = double.NaN;
                return st;
            }
            st.Active = true; st.S = s; st.Speed = speed;
            // picked up right on the start line (a recording replayed from its first sample): that is the start of a lap
            if (!havePrev && s >= g.Start && s < g.Start + 30.0 && speed > 20.0) lapStart = now - (s - g.Start) / (speed / 3.6);

            if (havePrev && s < prevS - 60.0)
            {
                done = 0; // a new lap, or a jump back
                if (!(prevS > g.Length - 300 && s < 300)) Restart(); // not the start line: a teleport
            }
            if (havePrev)
            {
                // crossing the timing lines (the start can sit just after the point where the line closes on itself)
                bool wasBefore = prevS < g.Start || prevS > g.Length - 300;
                if (wasBefore && s >= g.Start && s < g.Start + 300)
                    lapStart = now - (s - g.Start) / Math.Max(speed / 3.6, 1.0);
                if (!double.IsNaN(lapStart) && prevS < g.Finish && s >= g.Finish)
                {
                    double final = (now - (s - g.Finish) / Math.Max(speed / 3.6, 1.0) - lapStart) - (g.TimeAt(g.Finish) - g.TimeAt(g.Start));
                    if (!double.IsNaN(final)) Say("Okrążenie " + Signed(final, "0.00") + " s do odniesienia", final < 0.005 ? 2 : 3, now, 7.0);
                    lapStart = double.NaN; resultUntil = now + 7.0;
                }
            }
            double refNow = g.TimeAt(s), refStart = g.TimeAt(g.Start);
            st.OnLap = !double.IsNaN(lapStart) || now < resultUntil;
            st.Delta = double.IsNaN(lapStart) || double.IsNaN(refNow) || double.IsNaN(refStart) ? double.NaN : (now - lapStart) - (refNow - refStart);

            // Where the brake was last applied. Kept for the whole lap, not per corner: in a
            // sequence of corners the braking for the next one starts before the previous is left.
            bool onBrake = brake > BrakeOn;
            if (onBrake && !braking) lastOnset = s;
            braking = onBrake;

            // A corner is finished with once the car is past its slowest point and back on the
            // throttle (or well past where that was planned). In a run of corners that hands the
            // display to the next one while there is still time to count down to its point,
            // instead of waiting until the car has left the corner behind.
            // It is also finished with when nothing is left to do in it and the next corner's
            // braking or lift point is three seconds away or less: what is about to be needed wins.
            if (target >= 0 && target >= done && target + 1 < g.Corners.Count)
            {
                GuideCorner t = g.Corners[target], n = g.Corners[target + 1];
                bool gasDone = t.Pickup < 0 || !double.IsNaN(pickupAt) || s > t.Pickup + 40.0;
                bool hasPoint = (t.HasBrake && !t.Carried) || t.HasLift, nextPoint = (n.HasBrake && !n.Carried) || n.HasLift;
                bool tArmed = t.HasBrake ? brakeSeen : t.HasLift ? !double.IsNaN(liftAt) : lifted;
                bool pending = (hasPoint && s < t.Plan) || (braking && t.HasBrake && s < t.Release) || (tArmed && double.IsNaN(pickupAt) && t.Pickup > s);
                bool imminent = nextPoint && n.Plan > s && (n.Plan - s) / Math.Max(speed / 3.6, 5.0) <= 3.0;
                if ((s >= t.SMin + 5.0 && gasDone) || (!pending && imminent)) done = target + 1;
            }
            // the corner ahead or under the car: the first one not yet left or finished with
            int next = -1;
            for (int i = done; i < g.Corners.Count; i++) if (g.Corners[i].S1 + 25.0 > s) { next = i; break; }
            if (next != target)
            {
                if (target >= 0 && havePrev && (next == -1 || next > target)) Judge(g.Corners[target], now, s);
                // the next corner's slowest speed may already have been seen while this one was still being left
                slowest = target >= 0 && next == target + 1 ? slowestNext : double.MaxValue; slowestNext = double.MaxValue;
                target = next;
                brakeAt = double.NaN; window = 0; passed = false; passedAt = 0; releaseWindow = 0;
                gasWindow = 0; gasPassed = false; gasPassedAt = 0; pickupAt = double.NaN; gasFrom = double.NaN; gasTop = 0; gasLifted = false; brakeSeen = false; lifted = false;
                liftAt = double.NaN; floor = double.MaxValue; floorAt = 0; fullSeen = false; liftReal = false;
                appLast = double.NaN; mainOn = double.NaN; mainPeak = 0;
                tick1 = false; tick2 = false; toned = false; gasToned = false;
            }

            st.Phase = 0; st.BrakeNow = false; st.GasNow = false; st.LiftNow = false; st.Flat = false; st.Pressure = 0; st.Progress = 0; st.Mark = double.NaN;
            st.ToCorner = double.NaN; st.TargetSpeed = double.NaN; st.Corner = "";
            string note = "";
            if (target >= 0)
            {
                GuideCorner c = g.Corners[target];
                st.Corner = c.Label; st.Flat = c.Flat;
                bool ownBrake = c.HasBrake && !c.Carried, lift = c.HasLift;
                double point = ownBrake || lift ? c.Plan : c.S0, dist = point - s;
                // The plan was measured inside this corner's own zone, which begins where the previous
                // corner ends: one long application of the brake through two corners counts, for the
                // second one, from that boundary. The slowest speed is likewise the corner's own.
                double zone = Math.Max(target > 0 ? g.Corners[target - 1].S1 : 0.0, c.S0 - 250.0);
                // (a point planned before that boundary, inside the corner before, is this corner's all the same)
                if ((ownBrake || lift) && c.Plan - 40.0 < zone) zone = c.Plan - 40.0;
                if (double.IsNaN(brakeAt) && braking && s >= zone && s < c.SMin + 10.0) brakeAt = Math.Max(lastOnset, zone);
                // (a corner's own stretch never reaches back into the corner before it)
                if (s > Math.Max(c.S0 - 16.0, target > 0 ? g.Corners[target - 1].S1 : 0.0) && s < c.S1 + 16.0 && speed < slowest) slowest = speed;
                if (target + 1 < g.Corners.Count && s > Math.Max(g.Corners[target + 1].S0 - 16.0, c.S1) && speed < slowestNext) slowestNext = speed;
                if (onBrake && s >= zone && s <= c.S1)
                {
                    // a new application after more than 10 m off the pedal; one carried in from before the zone starts at its edge
                    if (double.IsNaN(appLast) || s - appLast > 10.0) { appOn = double.IsNaN(appLast) ? Math.Max(lastOnset, zone) : s; appPeak = 0; }
                    appLast = s;
                    if (brake > appPeak) appPeak = brake;
                    if (appPeak > mainPeak) { mainPeak = appPeak; mainOn = appOn; }
                }
                if (onBrake && s >= zone) brakeSeen = true;
                if (throttle <= ThrottleOn && s >= c.S0 - 100.0 && s <= c.S1) lifted = true; // (later than that it is the lift for the next corner)
                // where the throttle came off for this corner, and the lowest it went (and where that ended)
                // (a lift is one only if the throttle was full before it: coming in already off it is not)
                if (throttle >= FullThrottle && s >= zone) fullSeen = true;
                // Arriving on part throttle from the corner before does not count until the point itself is reached.
                if (double.IsNaN(liftAt) && throttle < FullThrottle && s >= zone && s >= point - 150.0 && (fullSeen || s >= point - 10.0) && s < c.SMin + 10.0) { liftAt = s; liftReal = fullSeen; }
                if (!double.IsNaN(liftAt) && s <= c.S1) { if (throttle < floor - 2.0) { floor = throttle; floorAt = s; } else if (throttle <= floor + 2.0) floorAt = s; }

                // Back on the throttle: the first time it is held after the braking for this corner
                // (after a lift, where the corner is not braked for). Braking again cancels it.
                bool armed = c.HasBrake ? brakeSeen : lift ? !double.IsNaN(liftAt) : lifted;
                if (onBrake) { gasFrom = double.NaN; if (s < c.SMin) { pickupAt = double.NaN; gasLifted = false; } }
                else if (lift)
                {
                    // a lift need not reach zero: back on it means clearly above the lowest it went
                    if (armed && double.IsNaN(pickupAt) && throttle >= floor + 15.0 && s - floorAt >= 4.0) { pickupAt = floorAt; gasTop = throttle; }
                }
                else if (throttle > ThrottleOn)
                {
                    if (double.IsNaN(gasFrom)) gasFrom = s;
                    if (armed && double.IsNaN(pickupAt) && s - gasFrom >= ThrottleHold) { pickupAt = gasFrom; gasTop = throttle; }
                }
                else gasFrom = double.NaN;
                // on the throttle and then clearly off it again: it came too early
                if (!double.IsNaN(pickupAt)) { if (throttle > gasTop) gasTop = throttle; else if (gasTop >= 30.0 && throttle < gasTop - 20.0) gasLifted = true; }

                st.ToCorner = dist > 0 ? dist : 0;
                if (c.HasBrake) st.Pressure = c.Pressure;
                if (ownBrake || lift)
                {
                    bool acted = lift ? !double.IsNaN(liftAt) : !double.IsNaN(brakeAt);
                    if (dist > 0)
                    {
                        if (window <= 0 && dist / Math.Max(speed / 3.6, 5.0) <= CountdownSeconds) window = dist;
                        if (window > 0)
                        {
                            st.Phase = lift ? 4 : 1; st.Progress = Math.Max(0, Math.Min(1, dist / window));
                            if (!lift && c.Shift >= 3.0 && c.Shift < window) st.Mark = c.Shift / window;
                        }
                        // For the ears. Braking: two ticks and then the tone at the point, evenly
                        // spaced, so the point can be felt coming. A lift: one tone at the point.
                        // Nothing once the driver has done it already.
                        double away = dist / Math.Max(speed / 3.6, 5.0);
                        if (!acted)
                        {
                            if (!toned && away <= SoundLead) { st.Sound = lift ? 4 : 2; toned = true; tick1 = true; tick2 = true; }
                            else if (!lift && !tick2 && away <= TickGap) { st.Sound = 1; tick2 = true; tick1 = true; }
                            else if (!lift && !tick1 && away <= 2 * TickGap) { st.Sound = 1; tick1 = true; }
                        }
                    }
                    else if (!passed)
                    {
                        passed = true; passedAt = now;
                        if (!toned && !acted) st.Sound = lift ? 4 : 2;
                        toned = true;
                    }
                    // past the point and, a moment later, still not on the brake (still flat on the throttle)
                    bool late = passed && !acted && s < c.SMin && now > passedAt + FlashGrace && now < passedAt + FlashGrace + FlashSeconds;
                    if (lift) st.LiftNow = late; else st.BrakeNow = late;
                    if (window > 0 || dist <= 0) st.TargetSpeed = c.MinSpeed;
                }
                else if (c.HasBrake) st.TargetSpeed = c.MinSpeed; // braking carried over from the corner before

                // while braking: how far to where the pedal should be off again
                if (c.HasBrake && c.Release > 0 && onBrake && s < c.Release && (c.Carried || dist <= 0))
                {
                    double left = c.Release - s;
                    if (releaseWindow <= 0) releaseWindow = left;
                    st.Phase = 3; st.Progress = Math.Max(0, Math.Min(1, left / releaseWindow)); st.ToCorner = left;
                }

                // after the braking or the lift: the way to the throttle point
                if (c.Pickup >= 0 && st.Phase == 0 && !st.BrakeNow && !st.LiftNow && double.IsNaN(pickupAt) && armed)
                {
                    double left = c.Pickup - s;
                    if (left > 0)
                    {
                        if (gasWindow <= 0) gasWindow = left;
                        st.Phase = 2; st.Progress = Math.Max(0, Math.Min(1, left / gasWindow)); st.ToCorner = left;
                        if (!gasToned && left / Math.Max(speed / 3.6, 5.0) <= SoundLead) { st.Sound = 3; gasToned = true; }
                    }
                    else
                    {
                        if (!gasPassed) { gasPassed = true; gasPassedAt = now; if (!gasToned) { st.Sound = 3; gasToned = true; } }
                        st.GasNow = !onBrake && now > gasPassedAt + FlashGrace && now < gasPassedAt + FlashGrace + FlashSeconds;
                    }
                }
                if (c.Note.Length > 0 && dist < 600.0) note = c.Note;
            }

            if (now < verdictUntil) { st.Message = verdict; st.MessageKind = verdictKind; }
            else if (note.Length > 0) { st.Message = note; st.MessageKind = 1; }
            else { st.Message = ""; st.MessageKind = 0; }

            prevS = s; havePrev = true;
            return st;
        }

        private void Restart()
        {
            havePrev = false; target = -1; done = 0; lapStart = double.NaN; verdictUntil = 0;
        }

        // How the corner just finished compares with the plan. Only what was off is named.
        private void Judge(GuideCorner c, double now, double s)
        {
            if (slowest == double.MaxValue) return; // joined the track past this corner
            var parts = new List<string>();
            bool worse = false;
            Func<double, string> m = v => Math.Round(Math.Abs(v)).ToString(CultureInfo.InvariantCulture) + " m";
            Func<double, string> pct = v => (Math.Round(v / 5) * 5).ToString(CultureInfo.InvariantCulture) + "%";
            bool armed = c.HasBrake ? brakeSeen : c.HasLift ? !double.IsNaN(liftAt) : lifted;
            if (c.HasBrake && !c.Carried)
            {
                if (double.IsNaN(mainOn)) parts.Add("bez hamulca");
                else
                {
                    double d = mainOn - c.Plan;
                    if (d < -OnPoint) { parts.Add("hamulec " + m(d) + " za wcześnie"); worse = true; }
                    else if (d > OnPoint) parts.Add("hamulec " + m(d) + " później");
                    // (how hard the pedal was pressed is not judged: the pressure shown is what the plan's lap used,
                    // and braking later with less of it has turned out to be the faster way)
                }
            }
            else if (c.HasLift)
            {
                // (braking that starts past the slowest point is for the corner after this one)
                if (!double.IsNaN(mainOn) && mainPeak >= 20 && mainOn < c.SMin) parts.Add("hamulec zbędny, wystarczy odpuścić");
                else if (!double.IsNaN(liftAt) && liftReal)
                {
                    double d = liftAt - c.Plan;
                    if (d < -GasOnPoint) { parts.Add("gaz puszczony " + m(d) + " za wcześnie"); worse = true; }
                    else if (d > GasOnPoint) parts.Add("gaz puszczony " + m(d) + " później");
                }
            }
            if (c.Pickup >= 0)
            {
                if (!double.IsNaN(pickupAt))
                {
                    double d = pickupAt - c.Pickup;
                    if (d > GasOnPoint) { parts.Add("gaz " + m(d) + " za późno"); worse = true; }
                    else if (d < -GasOnPoint && gasLifted) { parts.Add("gaz za wcześnie, cofnięty"); worse = true; }
                    else if (d < -GasOnPoint) parts.Add("gaz " + m(d) + " wcześniej");
                }
                else if (armed && s > c.Pickup + GasOnPoint) { parts.Add("gaz ponad " + m(s - c.Pickup) + " za późno"); worse = true; }
            }
            if (!c.Head && s >= c.SMin) // (handed over to the next corner before its slowest point: that speed was not seen)
            {
                double dv = slowest - c.MinSpeed;
                if (Math.Abs(dv) >= SpeedOnPoint) { parts.Add("szczyt " + Signed(dv, "0") + " km/h"); if (dv < 0) worse = true; }
            }
            // the two most telling remarks: the line has to be read at a glance
            if (parts.Count > 2) parts.RemoveRange(2, parts.Count - 2);
            string text = parts.Count == 0 ? "w punkt" : string.Join(" · ", parts.ToArray());
            // the corner's name too, while the line stays short enough
            string label = c.Label.Length + text.Length <= 50 ? c.Label : "Z" + c.Number.ToString(CultureInfo.InvariantCulture);
            Say(label + " · " + text, worse ? 3 : 2, now, VerdictSeconds);
        }

        private void Say(string text, int kind, double now, double seconds)
        {
            verdict = text; verdictKind = kind; verdictUntil = now + seconds;
        }

        public static string Signed(double v, string format)
        {
            // a plain hyphen: this typeface draws the typographic minus as wide as a dash
            // and no sign on a value that rounds to nothing: "-0" and "+0,00" read as mistakes
            string digits = Math.Abs(v).ToString(format, CultureInfo.InvariantCulture);
            bool zero = double.Parse(digits, CultureInfo.InvariantCulture) == 0;
            return (zero ? "" : v < 0 ? "-" : "+") + digits.Replace('.', ',');
        }
    }
}
